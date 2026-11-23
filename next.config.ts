import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite (solo desarrollo local sin DATABASE_URL) trae WASM: que no lo empaquete.
  serverExternalPackages: ["@electric-sql/pglite"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
