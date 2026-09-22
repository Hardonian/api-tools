# API Changelog Radar — justfile
# Install just: pipx install rust-just

# Detect and install deps + create .env
bootstrap:
    ./scripts/bootstrap.sh

# Run worker locally with wrangler dev
dev:
    cd deploy/workers && npx wrangler dev

# Run tests
test:
    cd deploy/workers && npm test

# Lint source code
lint:
    cd deploy/workers && npx eslint src/ tests/ || true

# Deploy to production
deploy:
    cd deploy/workers && npm run deploy

# Apply D1 migrations locally
db-migrate-local:
    cd deploy/workers && npm run db:migrate:local

# Apply D1 migrations to production
db-migrate:
    cd deploy/workers && npm run db:migrate

# Smoke / health check (production)
smoke:
    @curl -fsS https://api-changelog-radar.scottrmhardie.workers.dev/health | python3 -m json.tool

# Smoke / health check (local)
smoke-local:
    @curl -fsS http://localhost:8787/health | python3 -m json.tool

# Show worker logs
tail:
    cd deploy/workers && npx wrangler tail

# Show status
status:
    @curl -fsS https://api-changelog-radar.scottrmhardie.workers.dev/health || echo "Worker not responding"
