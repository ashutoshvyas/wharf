#!/usr/bin/env bash
# Assemble a runnable Next standalone bundle.
#
# `next build` with output:"standalone" emits .next/standalone/server.js and a
# minimal node_modules, but deliberately does NOT copy the static assets or
# public/ — the docs expect the deployer to do it. Skipping this yields a
# server that boots and then 404s every /_next/static/* request, so the app
# renders unstyled and client JS never loads.
#
# Run after every build, on the VPS and in E2E alike, so both exercise the
# exact artifact production runs.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [ ! -f .next/standalone/server.js ]; then
  echo "✗ .next/standalone/server.js missing — run 'npm run build' first." >&2
  exit 1
fi

mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static
cp -R .next/static .next/standalone/.next/static

if [ -d public ]; then
  rm -rf .next/standalone/public
  cp -R public .next/standalone/public
fi

# Prisma's query engine is loaded at runtime and is not always traced into the
# standalone node_modules; copy the generated client if it is absent.
if [ -d node_modules/.prisma ] && [ ! -d .next/standalone/node_modules/.prisma ]; then
  mkdir -p .next/standalone/node_modules
  cp -R node_modules/.prisma .next/standalone/node_modules/.prisma
fi

echo "✓ standalone bundle ready (.next/standalone/server.js)"
