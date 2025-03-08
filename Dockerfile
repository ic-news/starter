# Use a specific Node.js version for better reproducibility
FROM node:23

# Install pnpm globally and install necessary build tools
RUN npm install -g pnpm@9.15.1 && \
    apt-get update && \
    apt-get install -y git python3 make g++ libsqlite3-dev && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set Python 3 as the default python
RUN ln -s /usr/bin/python3 /usr/bin/python

# Set the working directory
WORKDIR /app

# Copy package.json and other configuration files
COPY ./ ./

# Install dependencies and build the project
RUN pnpm install 
# Explicitly rebuild better-sqlite3 to ensure native bindings are correctly compiled
RUN cd node_modules/better-sqlite3 && pnpm rebuild
RUN pnpm build 

# Create dist directory and set permissions
RUN mkdir -p /app/dist && \
    chown -R node:node /app && \
    chmod -R 755 /app

# Switch to node user
USER node

EXPOSE 3084
# Set the command to run the application
CMD ["pnpm", "start", "--character", "./characters/ic.news.character.json"]