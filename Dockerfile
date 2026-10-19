# ZAAFPulse server image: the dashboard, the agent gateway (/v1, /mcp, /a2a) and the MCP tools.
#   docker build -t zaafpulse .
#   docker run -d -p 4777:4777 -v zaafpulse-data:/data -e ZAAFPULSE_ADMIN_PASSWORD=... zaafpulse
# Or use compose.yaml. Data (config, keys, history, encrypted secrets) lives in the /data volume.
FROM node:24-alpine
WORKDIR /app
COPY bin ./bin
COPY lib ./lib
COPY public ./public
COPY skills ./skills
COPY scripts/register-mcp.js ./scripts/register-mcp.js
COPY server.js mcp.js package.json config.example.json LICENSE ./
ENV NODE_ENV=production \
    ZAAFPULSE_HOST=0.0.0.0 \
    ZAAFPULSE_PORT=4777 \
    ZAAFPULSE_DATA=/data \
    ZAAFPULSE_SECRET_STORE=file
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4777
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- --header='Host: localhost' http://127.0.0.1:4777/api/session >/dev/null || exit 1
ENTRYPOINT ["node", "bin/zaafpulse.js"]
CMD ["start"]
