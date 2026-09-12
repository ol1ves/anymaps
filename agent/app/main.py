from fastapi import FastAPI

app = FastAPI(title="anymaps agent service")


@app.get("/health")
def health():
    return {"status": "ok"}
