#!/bin/sh
set -eu

# Optional worker process: RabbitMQ user-actions consumer only (no HTTP API).
# Enable via docker compose profile `worker`.
exec node -e "require('./dist/bus/userActionsConsumer').startConsumer().catch((e)=>{console.error(e);process.exit(1)})"
