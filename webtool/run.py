# webtool/run.py
from webtool.server import app
from webtool import config

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=config.PORT)
