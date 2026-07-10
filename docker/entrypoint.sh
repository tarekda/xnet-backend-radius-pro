#!/bin/sh
set -eu

# Apply pending TypeORM migrations before serving traffic.
# Skip with SKIP_MIGRATIONS=1 for emergency boots against a known-good schema.
if [ "${SKIP_MIGRATIONS:-0}" != "1" ]; then
  echo "Running database migrations..."
  npx typeorm migration:run -d ./dist/db/config.js
fi

exec node dist/server.js