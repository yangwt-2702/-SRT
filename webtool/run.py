# webtool/run.py
from webtool.server import app
from webtool import config

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=config.PORT)
