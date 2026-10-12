# Run noro in Docker

The image has Node 24, Python 3 and noro, so the host needs only Docker. It is published as `ghcr.io/noro-to/noro` for `linux/amd64` and `linux/arm64`, tagged `latest` and with each version (for example `0.2.0`).

## Run the published image

From the folder that holds your export and your `.env`:

```bash
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:/work" -w /work \
  --env-file .env \
  ghcr.io/noro-to/noro:latest this exports/google-ads.csv
```

- `-v "$PWD:/work" -w /work` makes your folder the working folder, so the export path is relative to it and run state lands in `./.noro/`.
- `--user` keeps the files in `.noro/` owned by you on Linux. Docker Desktop on macOS and Windows doesn't need it.
- `--env-file .env` passes your keys and model settings.
- In PowerShell, write the mount as `-v "${PWD}:/work"`.
- With no terminal (cron, CI), drop `-it` and add `--yes`.

Other commands work the same way:

```bash
docker run --rm -v "$PWD:/work" -w /work --env-file .env ghcr.io/noro-to/noro:latest doctor
docker run --rm -v "$PWD:/work" -w /work ghcr.io/noro-to/noro:latest facts exports/google-ads.csv
```

## Build the image yourself

The repo has a `Dockerfile` at its root.

```bash
git clone https://github.com/noro-to/noro
cd noro
docker build -t noro .
cd ~/reports
docker run --rm -it -v "$PWD:/work" -w /work --env-file .env noro this exports/google-ads.csv
```

## Writers that don't work in the container

`claude-cli` and `codex-cli` need your own login on your own machine, so they don't run in the container. Use an API provider from [providers.md](providers.md).

## A local model on the host

To reach Ollama or LM Studio running on the host, point noro at `host.docker.internal`:

```bash
# .env
NORO_MODEL=ollama:qwen3.8:27b
NORO_BASE_URL=http://host.docker.internal:11434
```

On Linux, add `--add-host=host.docker.internal:host-gateway` to `docker run`. See [local.md](local.md) for the server setup.
