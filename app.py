import os
import logging
from datetime import datetime
from dotenv import load_dotenv
from flask import Flask, render_template
from flask_compress import Compress

from config import config

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def create_app():
    app = Flask(__name__)
    Compress(app)
    env = os.environ.get('FLASK_ENV', 'development')
    app.config.from_object(config.get(env, config['development']))
    app.config['ENV'] = env
    app.jinja_env.auto_reload = True

    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

    from routes.auth import auth_bp
    from routes.pages import pages_bp
    from routes.tasks import tasks_bp
    from routes.warehouse import warehouse_bp
    from routes.ppr import ppr_bp
    from routes.fn import fn_bp
    from routes.notifications import notif_bp
    from routes.misc import misc_bp
    from routes.route import route_bp
    from routes.references import references_bp
    from routes.fias import fias_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(pages_bp)
    app.register_blueprint(tasks_bp)
    app.register_blueprint(warehouse_bp)
    app.register_blueprint(ppr_bp)
    app.register_blueprint(fn_bp)
    app.register_blueprint(notif_bp)
    app.register_blueprint(misc_bp)
    app.register_blueprint(route_bp)
    app.register_blueprint(references_bp)
    app.register_blueprint(fias_bp)

    @app.context_processor
    def inject_now():
        return {'now': datetime.now}

    @app.errorhandler(404)
    def not_found(e):
        return render_template('404.html'), 404

    return app


app = create_app()

from routes.helpers import start_background_worker
start_background_worker()

if __name__ == '__main__':
    debug = app.config['ENV'] == 'development'
    app.run(host='0.0.0.0', port=5000, debug=debug)
