# Contributing to Squish

Thank you for contributing to Squish! This document provides guidelines for development, testing, and submitting changes.

## Development Setup

### Prerequisites
- Node.js >=18
- Bun >=1.0
- Docker (for Squish Cloud team mode testing)
- Git

### Initial Setup

```bash
# Clone the repository
git clone https://github.com/michielhdoteth/squish.git
cd squish

# Install dependencies
bun install

# Build the project
bun run build

# Create a development branch
git checkout -b feature/your-feature-name
```

## Development Workflow

### Running the Server

```bash
# Hot-reload development mode
bun run dev:server

# Production build
bun run build:server

# Run specific package
bun run --filter squish dev
```

### Testing

```bash
# Run all tests
bun run test

# Run tests for specific package
bun run --filter squish test

# Run with coverage
bun run test -- --coverage
```

### Debugging

```bash
# Enable debug logs
DEBUG=squish:* bun run dev:server

# View web UI
open http://localhost:37777
```

### Docker (Squish Cloud Team Mode)

```bash
# Start Docker services
bun run docker:up

# Stop Docker services
bun run docker:down

# View logs
docker compose -f infra/docker-compose.yml logs -f
```

## Code Style

### TypeScript

- Use strict mode (`strict: true` in tsconfig)
- Avoid `any` types - use proper TypeScript types
- Use interfaces for public APIs
- Document complex functions with JSDoc

```typescript
// Good
interface Memory {
  id: string;
  content: string;
  embeddings: number[];
}

// Bad
function store(data: any) {
  // ...
}
```

### Naming Conventions

- Files: `kebab-case.ts`
- Functions/Variables: `camelCase`
- Classes: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`

### Formatting

- Use Prettier (auto-formatted by editor)
- Line length: 100 characters
- Indentation: 2 spaces

## Commit Guidelines

### Commit Messages

Follow conventional commits format:

```
type(scope): subject

body (optional)

footer (optional)
```

**Types:**
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation
- `style` - Code style
- `refactor` - Code refactoring
- `perf` - Performance improvement
- `test` - Adding tests
- `chore` - Build/tooling changes

**Examples:**
```bash
git commit -m "feat(services): add sentiment analysis to memories"
git commit -m "fix(search): fix semantic search ranking"
git commit -m "docs: update installation instructions"
```

## Secret Scanning

To prevent accidental commits of API keys and credentials, Squish includes automated secret scanning.

### Local Checks
- Run `npm run check:secrets` before pushing to scan staged files
- Install the pre-commit hook: `cp git-hooks/pre-commit .git/hooks/` (manual)
  Or use Husky: `npx husky add .husky/pre-commit "npm run check:secrets"`

### CI Checks
GitHub Actions runs TruffleHog on every PR and push to main. If secrets are found, the check fails and must be resolved before merging.

If a secret is exposed:
1. Immediately rotate/revoke the compromised credential
2. Remove it from the codebase and commit the change
3. Do not rewrite history unless absolutely necessary (coordinate with maintainers)

## Pull Request Process

1. **Create a feature branch**
   ```bash
   git checkout -b feature/my-feature
   ```

2. **Make changes and commit**
   ```bash
   git add .
   git commit -m "feat: add my feature"
   ```

3. **Push to your fork**
   ```bash
   git push origin feature/my-feature
   ```

4. **Open a PR** with:
   - Clear title
   - Description of changes
   - Link to related issues
   - Test results

5. **Address review feedback**

6. **Squash commits** (if requested)
   ```bash
   git rebase -i origin/main
   ```

## Testing

### Writing Tests

```typescript
// Use Node.js test runner
import test from 'node:test';
import assert from 'node:assert';

test('should store and retrieve memory', async () => {
  const memory = await store('test memory');
  assert.equal(memory.id, 'expected-id');
});
```

### Test Coverage

- Aim for >80% coverage
- Test happy paths and edge cases
- Test error conditions
- Mock external services

## Documentation

### Code Comments

```typescript
// Explain WHY, not WHAT
// Good:
// Use debouncing to avoid excessive database writes during rapid captures
const debouncedCapture = debounce(capture, 2000);

// Bad:
// Capture memories
const debouncedCapture = debounce(capture, 2000);
```

### README Updates

Update package READMEs when:
- Adding new features
- Changing configuration
- Modifying API endpoints
- Adding new dependencies

### Documentation Files

- `docs/MCP-SERVER.md` - MCP server reference
- `docs/ARCHITECTURE.md` - System design
- `docs/CLI.md` - CLI reference
- `docs/CONTRIBUTING.md` - This file

## Performance

### Guidelines

- Avoid N+1 queries
- Cache frequently accessed data
- Use indexes for searches
- Profile before optimizing

### Benchmarking

```bash
# Run benchmarks
cd benchmarks
bun run memory.ts
bun run run.ts

# Compare performance
bun run bench
```

## Release Process

1. **Update version**
   ```bash
   # In root package.json
   "version": "X.Y.Z"
   ```

2. **Update CHANGELOG.md** with notable changes for this release

3. **Create commit**
   ```bash
   git add .
   git commit -m "chore: release vX.Y.Z"
   ```

4. **Create git tag**
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. **Automated Release**
   - GitHub Actions will build, test, and publish the release
   - Monitor the Actions workflow for any failures
   - Once complete, verify the release on GitHub Releases page

## Architecture Decisions

### Adding a New Service

1. Create `src/services/my-service.ts`
2. Export interface and implementation
3. Register in `src/index.ts`
4. Add tests in `src/services/my-service.test.ts`
5. Document in ARCHITECTURE.md

### Modifying Database Schema

1. Update `drizzle/schema.ts` (PostgreSQL) and `drizzle/schema-sqlite.ts` (SQLite)
2. Generate migration: `bun run db:generate`
3. Test migration locally
4. Document schema changes

### Adding MCP Tools

1. Define tool in `src/index.ts` (list and definition)
2. Implement handler function
3. Add tests
4. Update documentation

## Troubleshooting

### Common Issues

**Build fails**
```bash
# Clean and rebuild
bun run clean
bun install
bun run build
```

**Tests failing**
```bash
# Check database is running
docker ps | grep postgres

# Check environment variables
echo $DATABASE_URL
```

**Performance issues**
```bash
# Check database queries
DEBUG=squish:* bun run dev:server

# Run benchmarks
bun run bench
```

## Resources

- [MCP Specification](https://modelcontextprotocol.io)
- [Drizzle ORM Docs](https://orm.drizzle.team)
- [PostgreSQL pgvector](https://github.com/pgvector/pgvector)
- [Node.js Testing](https://nodejs.org/api/test.html)

## Questions?

- Open an issue on GitHub
- Check existing discussions
- Review documentation

## Code of Conduct

Be respectful, inclusive, and professional in all interactions. We're all here to build something great together!
