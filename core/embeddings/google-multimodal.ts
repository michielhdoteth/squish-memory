import { logger } from '../logger.js';
import { config } from '../../config.js';
import { validateOutboundUrl } from '../lib/url-validator.js';

export interface MultimodalInput {
  text?: string;
  image?: Buffer | string;
  video?: string;
}

export interface GoogleMultimodalResponse {
  embedding: number[];
  textEmbedding?: number[];
  imageEmbedding?: number[];
  videoEmbedding?: number[];
}

export async function getGoogleMultimodalEmbedding(
  input: MultimodalInput
): Promise<GoogleMultimodalResponse | null> {
  if (!config.googleCloudApiKey && !config.googleCloudProject) {
    logger.debug('Google Cloud credentials not configured');
    return null;
  }

  if (!config.googleEmbeddingModel) {
    logger.debug('Google embedding model not configured');
    return null;
  }

  try {
    const endpoint = config.googleCloudLocation === 'global'
      ? `https://aiplatform.googleapis.com/v1/projects/${config.googleCloudProject}/locations/${config.googleCloudLocation}/publishers/google/models/${config.googleEmbeddingModel}:predict`
      : `https://${config.googleCloudLocation}-aiplatform.googleapis.com/v1/projects/${config.googleCloudProject}/locations/${config.googleCloudLocation}/publishers/google/models/${config.googleEmbeddingModel}:predict`;

    const instances: any[] = [];

    if (input.text) {
      instances.push({ text: input.text });
    }

    if (input.image) {
      const imageBytes = typeof input.image === 'string'
        ? input.image
        : input.image.toString('base64');
      
      instances.push({
        image: {
          bytesBase64Encoded: imageBytes,
        },
      });
    }

    if (input.video) {
      instances.push({
        video: {
          gcsUri: input.video,
        },
      });
    }

    if (instances.length === 0) {
      return null;
    }

    validateOutboundUrl(endpoint);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${await getGoogleAccessToken()}`,
      },
      body: JSON.stringify({
        instances,
        parameters: {
          dimension: 1408,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn(`Google Multimodal embeddings failed: ${response.status} ${errorText}`);
      return null;
    }

    const data = await response.json() as { predictions?: any[] };
    const predictions = data.predictions || [];

    const result: GoogleMultimodalResponse = {
      embedding: predictions[0]?.embedding || [],
    };

    if (input.text && predictions[0]?.textEmbedding) {
      result.textEmbedding = predictions[0].textEmbedding;
    }

    if (input.image && predictions[0]?.imageEmbedding) {
      result.imageEmbedding = predictions[0].imageEmbedding;
    }

    if (input.video && predictions[0]?.videoEmbedding) {
      result.videoEmbedding = predictions[0].videoEmbedding;
    }

    return result.embedding.length > 0 ? result : null;
  } catch (error) {
    logger.error('Google Multimodal embedding error:', error);
    return null;
  }
}

let cachedAccessToken: string | null = null;
let tokenExpiry: number = 0;

async function getGoogleAccessToken(): Promise<string> {
  if (config.googleCloudApiKey) {
    return config.googleCloudApiKey;
  }

  if (cachedAccessToken && Date.now() < tokenExpiry) {
    return cachedAccessToken;
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('Google Application Credentials not set');
  }

  try {
    const credentials = JSON.parse(
      await import('fs').then(fs => 
        fs.promises.readFile(process.env.GOOGLE_APPLICATION_CREDENTIALS!, 'utf-8')
      )
    );

    const now = Math.floor(Date.now() / 1000);
    const jwt = await createJWT(credentials);

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error('Failed to get Google access token');
    }

    const tokenData = await tokenResponse.json() as { access_token: string; expires_in: number };
    cachedAccessToken = tokenData.access_token;
    tokenExpiry = now + tokenData.expires_in - 60;

    return cachedAccessToken;
  } catch (error) {
    logger.error('Failed to get Google access token:', error);
    throw error;
  }
}

async function createJWT(credentials: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const payload = {
    iss: credentials.client_email,
    sub: credentials.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
  };

  const crypto = await import('crypto');
  
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signatureInput);
  const signature = sign.sign(credentials.private_key, 'base64url');

  return `${signatureInput}.${signature}`;
}

export function isMultimodalInput(input: any): input is MultimodalInput {
  return (
    typeof input === 'object' &&
    (typeof input.text === 'string' ||
     Buffer.isBuffer(input.image) ||
     typeof input.image === 'string' ||
     typeof input.video === 'string')
  );
}
