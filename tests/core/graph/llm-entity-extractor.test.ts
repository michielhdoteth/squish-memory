import { describe, expect, it } from 'bun:test';
import { testParseLLMResponse, testValidateLLMResponse } from '../../../core/graph/llm-entity-extractor.js';

describe('document-centered entity extraction vocabulary', () => {
  it('preserves explicit document, party, citation, version, status, and date types', () => {
    const parsed = testParseLLMResponse(JSON.stringify({
      entities: [
        { name: 'Northstar Acquisition', type: 'matter' },
        { name: 'Acme Holdings', type: 'organization' },
        { name: 'Purchase Agreement', type: 'document' },
        { name: 'Purchase Agreement v2', type: 'document_version' },
        { name: 'Executed', type: 'status' },
        { name: '2026-04-12', type: 'date' },
      ],
      relations: [
        { from: 'Acme Holdings', to: 'Northstar Acquisition', type: 'party_to' },
        { from: 'Purchase Agreement', to: 'Northstar Acquisition', type: 'cites' },
        { from: 'Purchase Agreement v2', to: 'Purchase Agreement', type: 'version_of' },
        { from: 'Purchase Agreement v2', to: 'Purchase Agreement', type: 'supersedes_version' },
        { from: 'Purchase Agreement v2', to: 'Executed', type: 'has_status' },
        { from: 'Purchase Agreement v2', to: '2026-04-12', type: 'dated_on' },
      ],
    }));

    expect(parsed?.entities.map((entity) => entity.type)).toEqual([
      'matter', 'organization', 'document', 'document_version', 'status', 'date',
    ]);
    expect(parsed?.relations.map((relation) => relation.relationType)).toEqual([
      'party_to', 'cites', 'version_of', 'supersedes_version', 'has_status', 'dated_on',
    ]);
  });

  it('keeps unsupported model labels within the existing safe fallback types', () => {
    const parsed = testParseLLMResponse(JSON.stringify({
      entities: [{ name: 'Unrecognized Asset', type: 'unsupported_asset_kind' }],
      relations: [{ from: 'Unrecognized Asset', to: 'Other', type: 'unsupported_relation' }],
    }));

    expect(parsed?.entities[0]?.type).toBe('other');
    expect(parsed?.relations[0]?.relationType).toBe('related_to');
  });

  it('drops a relation when only one endpoint is supported by the source text', () => {
    const result = testValidateLLMResponse('Acme Holdings signed the purchase agreement.', JSON.stringify({
      entities: [
        { name: 'Acme Holdings', type: 'organization' },
        { name: 'Northstar Acquisition', type: 'matter' },
      ],
      relations: [
        { from: 'Acme Holdings', to: 'Northstar Acquisition', type: 'party_to' },
      ],
    }));

    expect(result?.entities.map((entity) => entity.name)).toEqual(['Acme Holdings']);
    expect(result?.relations).toEqual([]);
  });

  it('accepts a relation only when both endpoints are explicitly mentioned', () => {
    const result = testValidateLLMResponse(
      'Acme Holdings is a party to Northstar Acquisition.',
      JSON.stringify({
        entities: [
          { name: 'Acme Holdings', type: 'organization' },
          { name: 'Northstar Acquisition', type: 'matter' },
        ],
        relations: [
          {
            from: 'Acme Holdings',
            to: 'Northstar Acquisition',
            type: 'party_to',
            context: 'Acme Holdings is a party to Northstar Acquisition.',
          },
        ],
      }),
    );

    expect(result?.relations.map((relation) => [relation.fromEntity, relation.toEntity])).toEqual([
      ['Acme Holdings', 'Northstar Acquisition'],
    ]);
  });

  it('rejects a typed relation when its direction reverses the source wording', () => {
    const result = testValidateLLMResponse('Acme manages Atlas.', JSON.stringify({
      entities: [
        { name: 'Acme', type: 'organization' },
        { name: 'Atlas', type: 'concept' },
      ],
      relations: [{
        from: 'Atlas',
        to: 'Acme',
        type: 'manages',
        context: 'Acme manages Atlas.',
      }],
    }));

    expect(result?.relations).toEqual([]);
  });

  it('preserves directed edges expressed with passive wording', () => {
    const result = testValidateLLMResponse('Atlas is managed by Acme.', JSON.stringify({
      entities: [
        { name: 'Acme', type: 'organization' },
        { name: 'Atlas', type: 'concept' },
      ],
      relations: [{
        from: 'Acme',
        to: 'Atlas',
        type: 'manages',
        context: 'Atlas is managed by Acme.',
      }],
    }));

    expect(result?.relations.map(({ fromEntity, toEntity }) => [fromEntity, toEntity])).toEqual([
      ['Acme', 'Atlas'],
    ]);
  });

  it('preserves the newer-to-older direction in passive supersession wording', () => {
    const result = testValidateLLMResponse(
      'The 2025 Purchase Agreement was superseded by the 2026 Purchase Agreement.',
      JSON.stringify({
        entities: [
          { name: '2026 Purchase Agreement', type: 'document_version' },
          { name: '2025 Purchase Agreement', type: 'document_version' },
        ],
        relations: [{
          from: '2026 Purchase Agreement',
          to: '2025 Purchase Agreement',
          type: 'supersedes_version',
          context: 'The 2025 Purchase Agreement was superseded by the 2026 Purchase Agreement.',
        }],
      }),
    );

    expect(result?.relations.map(({ fromEntity, toEntity }) => [fromEntity, toEntity])).toEqual([
      ['2026 Purchase Agreement', '2025 Purchase Agreement'],
    ]);
  });

  it('does not combine endpoint mentions from separate sentences into a relation', () => {
    const result = testValidateLLMResponse('Acme manages the portfolio. Atlas was added to the index.', JSON.stringify({
      entities: [
        { name: 'Acme', type: 'organization' },
        { name: 'Atlas', type: 'concept' },
      ],
      relations: [{
        from: 'Acme',
        to: 'Atlas',
        type: 'manages',
        context: 'Acme manages the portfolio. Atlas was added to the index.',
      }],
    }));

    expect(result?.relations).toEqual([]);
  });

  it('matches a directed cue to the correct repeated entity mentions', () => {
    const result = testValidateLLMResponse('Atlas manages Acme. Acme manages Atlas.', JSON.stringify({
      entities: [
        { name: 'Acme', type: 'organization' },
        { name: 'Atlas', type: 'concept' },
      ],
      relations: [{
        from: 'Acme',
        to: 'Atlas',
        type: 'manages',
        context: 'Atlas manages Acme. Acme manages Atlas.',
      }],
    }));

    expect(result?.relations.map(({ fromEntity, toEntity }) => [fromEntity, toEntity])).toEqual([
      ['Acme', 'Atlas'],
    ]);
  });

  it('rejects quoted but negated or mistyped relationship evidence', () => {
    const content = 'Acme does not manage Atlas. Atlas uses PostgreSQL.';
    const result = testValidateLLMResponse(content, JSON.stringify({
      entities: [
        { name: 'Acme', type: 'organization' },
        { name: 'Atlas', type: 'concept' },
        { name: 'PostgreSQL', type: 'tool' },
      ],
      relations: [
        { from: 'Acme', to: 'Atlas', type: 'manages', context: 'Acme does not manage Atlas.' },
        { from: 'Atlas', to: 'PostgreSQL', type: 'manages', context: 'Atlas uses PostgreSQL.' },
      ],
    }));

    expect(result?.relations).toEqual([]);
  });

  it('rejects a typed relation whose proposed evidence is not quoted from the source', () => {
    const result = testValidateLLMResponse(
      'Acme Holdings attended the conference. Northstar Acquisition was discussed separately.',
      JSON.stringify({
        entities: [
          { name: 'Acme Holdings', type: 'organization' },
          { name: 'Northstar Acquisition', type: 'matter' },
        ],
        relations: [{
          from: 'Acme Holdings',
          to: 'Northstar Acquisition',
          type: 'party_to',
          context: 'Acme Holdings is a party to Northstar Acquisition.',
        }],
      }),
    );

    expect(result?.entities).toHaveLength(2);
    expect(result?.relations).toEqual([]);
  });

  it('rejects a typed document relation when the source has no matching relation cue', () => {
    const result = testValidateLLMResponse('Acme Holdings signed the Purchase Agreement.', JSON.stringify({
      entities: [
        { name: 'Acme Holdings', type: 'organization' },
        { name: 'Purchase Agreement', type: 'document' },
      ],
      relations: [{
        from: 'Acme Holdings',
        to: 'Purchase Agreement',
        type: 'supersedes_version',
        context: 'Acme Holdings signed the Purchase Agreement.',
      }],
    }));

    expect(result?.entities).toHaveLength(2);
    expect(result?.relations).toEqual([]);
  });

  it('matches complete entity names at word boundaries, not incidental substrings', () => {
    const result = testValidateLLMResponse('The annual report mentions Acme Holdings.', JSON.stringify({
      entities: [
        { name: 'Ann', type: 'person' },
        { name: 'Acme', type: 'organization' },
        { name: 'Acme Holdings', type: 'organization' },
      ],
      relations: [],
    }));

    expect(result?.entities.map((entity) => entity.name)).toEqual(['Acme', 'Acme Holdings']);
  });
});
