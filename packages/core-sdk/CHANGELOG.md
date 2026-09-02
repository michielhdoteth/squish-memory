# Changelog

## 2.0.0 (2026-07-20)

### Added
- Initial SDK release
- Pluggable storage provider interface
- Pluggable embedding provider interface
- Pluggable LLM provider interface
- Event system interface
- Configuration interface
- TypeScript types for all interfaces
- Unit tests for interface compilation

### Phase 1: Plugin Interface Contracts
- Created `StorageProvider` interface with CRUD, search, graph, and schema operations
- Created `EmbeddingProvider` interface with single and batch embedding support
- Created `LLMProvider` interface with multimodal content support
- Created `EventBus` interface with typed events
- Created `SquishConfig` interface for SDK configuration
- Added comprehensive JSDoc documentation for all interfaces
- Verified all interfaces compile with strict TypeScript
- Added unit tests to ensure interface validity

### Next Steps
- Phase 2: Event System Implementation
- Phase 3: SDK Package Structure (SquishClient, adapters, builders)
- Phase 4: Refactor Consumers to use SDK
- Phase 5: Default Provider Implementations
- Phase 6: TypeScript Types and Exports
- Phase 7: Testing Strategy
- Phase 8: Documentation
- Phase 9: Workspace Configuration
