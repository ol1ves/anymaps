FROM python:3.12-slim

WORKDIR /app

COPY agent/requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY agent ./agent
COPY shared ./shared
COPY contracts ./contracts
COPY client/src/sdk ./client/src/sdk
COPY CONTRACTS.md ./CONTRACTS.md
COPY SPEC.md ./SPEC.md

CMD ["uvicorn", "agent.app.main:app", "--host", "0.0.0.0", "--port", "8001"]
