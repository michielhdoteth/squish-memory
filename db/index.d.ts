import { createDb } from './adapter.js';
import { config } from '../config.js';
export declare function getDb(): Promise<any>;
export declare function resetDb(): void;
export declare function closeAllDbs(): Promise<void>;
export declare function checkDatabaseHealth(): Promise<boolean>;
export { config };
export { createDb };
//# sourceMappingURL=index.d.ts.map