#!/bin/bash

echo "🚀 Installing delivery platform modules..."

# 1 Install docker if missing
if ! command -v docker &> /dev/null
then
    echo "Installing Docker..."
    sudo apt update
    sudo apt install -y docker.io docker-compose
fi

# 2 Create docker-compose
cat << 'EOT' > docker-compose.yml
version: "3"

services:
  postgres:
    image: postgis/postgis:15-3.3
    container_name: delivery_postgres
    restart: always
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: admin
      POSTGRES_PASSWORD: admin
      POSTGRES_DB: delivery
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
EOT

echo "🐳 Starting PostGIS container..."
docker compose up -d

sleep 8

echo "🗺 Creating database schema..."

docker exec -i delivery_postgres psql -U admin -d delivery <<SQL

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS couriers (
 id SERIAL PRIMARY KEY,
 name TEXT,
 status TEXT,
 location GEOGRAPHY(POINT)
);

CREATE TABLE IF NOT EXISTS restaurants (
 id SERIAL PRIMARY KEY,
 name TEXT,
 location GEOGRAPHY(POINT)
);

CREATE TABLE IF NOT EXISTS orders (
 id SERIAL PRIMARY KEY,
 restaurant_id INT,
 delivery_point GEOGRAPHY(POINT),
 courier_id INT,
 status TEXT
);

CREATE INDEX IF NOT EXISTS idx_couriers_location
ON couriers USING GIST (location);

CREATE INDEX IF NOT EXISTS idx_restaurants_location
ON restaurants USING GIST (location);

SQL

echo "📁 Creating backend modules..."

mkdir -p src/delivery

cat << 'EOT' > src/delivery/courier.ts
import { pool } from "../db";

export async function findCourier(lat:number,lon:number){

 const q=\`
 SELECT id,
 ST_Distance(location,ST_MakePoint($1,$2)::geography) distance
 FROM couriers
 WHERE status='free'
 ORDER BY distance
 LIMIT 1
 \`

 const r=await pool.query(q,[lon,lat])
 return r.rows[0]
}
EOT

cat << 'EOT' > src/delivery/zones.ts
import { pool } from "../db";

export async function checkDelivery(lat:number,lon:number){

 const q=\`
 SELECT *
 FROM restaurants
 WHERE ST_DWithin(
 location,
 ST_MakePoint($1,$2)::geography,
 5000
 )
 \`

 const r=await pool.query(q,[lon,lat])
 return r.rows
}
EOT

cat << 'EOT' > src/delivery/orders.ts
import { pool } from "../db";
import { findCourier } from "./courier";

export async function createOrder(lat:number,lon:number){

 const courier=await findCourier(lat,lon)

 const q=\`
 INSERT INTO orders(delivery_point,courier_id,status)
 VALUES(
 ST_MakePoint($1,$2),
 $3,
 'new'
 )
 RETURNING *
 \`

 const r=await pool.query(q,[lon,lat,courier?.id])
 return r.rows[0]
}
EOT

echo "✅ Delivery system installed!"
echo ""
echo "Next step:"
echo "npm install pg"
echo "npm run dev"

