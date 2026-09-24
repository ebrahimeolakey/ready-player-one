FROM electronuserland/builder:22
WORKDIR /project
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci
# Copy source explicitly: never overwrite Linux native dependencies with host node_modules.
COPY src ./src
COPY desktop ./desktop
COPY core ./core
COPY assets ./assets
COPY index.html vite.config.ts tsconfig.json LICENSE NOTICE ./
RUN npm run distribute:linux
# AppImage/ZIP are under /project/release. A real desktop test still needs a display.
