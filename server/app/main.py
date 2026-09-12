from fastapi import FastAPI

app = FastAPI(title="anymaps generic widget server")


@app.get("/health")
def health():
    return {"status": "ok"}
