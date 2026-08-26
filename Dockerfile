FROM node:20-alpine

# Install pnpm
RUN npm install -g pnpm@10.13.1

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source code
COPY . .

# Clean any stale build artifacts and rebuild
RUN rm -rf dist && pnpm build

# Expose port
EXPOSE 3008

# Start the server
CMD ["node", "dist/index.js"]
