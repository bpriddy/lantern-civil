# The Civil runner: executes project code, holds one secret (PRD 12).
#
# Built from the repository root so civil-runtime ships inside the image — the
# runner imports it the same way it does in the repo, as a sibling.

FROM python:3.12-slim

WORKDIR /app

COPY runner/requirements.txt runner/requirements.txt
RUN pip install --no-cache-dir -r runner/requirements.txt

COPY runtime/src runtime/src
COPY runner/server.py runner/execute.py runner/agent.py runner/

# Cloud Run injects PORT; the server binds it.
CMD ["python", "-u", "runner/server.py"]
