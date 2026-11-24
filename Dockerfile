FROM node:22-alpine

# Run as an unprivileged user; the hub only needs to read its code and write /data.
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY server ./server
RUN mkdir -p /data && chown -R app:app /data
USER app

VOLUME ["/data"]
EXPOSE 8787

# Listen on all interfaces inside the container; publish the port on the host only.
ENTRYPOINT ["node", "server/standalone.mjs", "--dir", "/data", "--host", "0.0.0.0"]
