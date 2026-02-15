
#!/bin/bash

# Reset local Archestra stack, volumes, and images for a clean environment.

echo "🚨 WARNING: This will delete the existing Archestra container and ALL DATA!"
echo "Press Ctrl+C to cancel, or wait 5 seconds to proceed..."
sleep 5

echo "🛑 Stopping Archestra..."
docker compose down

echo "🗑️  Removing Data Volumes..."
docker compose down -v
# Also try to remove any old standalone volumes just in case
docker volume rm archestra_db_data 2>/dev/null
docker volume rm archestra_redis_data 2>/dev/null

echo "⬇️  Pulling Latest Images..."
docker compose pull

echo "🚀 Starting Fresh Archestra..."
docker compose up -d

echo "✅ Done! Please wait approx 1-2 mins for services to initialize."
echo "   Then visit http://127.0.0.1:3000 to set up your new admin account."
