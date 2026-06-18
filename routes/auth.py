import secrets
from datetime import datetime
from flask import Blueprint, render_template, request, redirect, url_for, session, flash
from api_client import OneSApiClient
from db import save_user_credentials, delete_user_subscriptions
from .helpers import SERVER_HOST, SERVER_PORT, SERVER_DB

auth_bp = Blueprint('auth', __name__)


@auth_bp.route('/')
def index():
    if session.get('authenticated'):
        return redirect(url_for('pages.tasks_page'))
    return redirect(url_for('auth.login'))


@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'GET':
        csrf_token = secrets.token_hex(32)
        session['csrf_token'] = csrf_token
        session.permanent = True

    if request.method == 'POST':
        token = session.get('csrf_token')
        form_token = request.form.get('csrf_token')
        if not token or not form_token or not secrets.compare_digest(token, form_token):
            flash('Session expired, please try again', 'warning')
            csrf_token = secrets.token_hex(32)
            session['csrf_token'] = csrf_token
            return render_template('login.html')

        host = SERVER_HOST
        port = SERVER_PORT
        db_name = SERVER_DB
        if not host or not port or not db_name:
            flash('Server, port and database must be configured', 'danger')
            return render_template('login.html')

        username = request.form.get('username', '').strip()
        password = request.form.get('password', '').strip()

        try:
            client = OneSApiClient(
                host=host, port=port, db_name=db_name,
                username=username, password=password,
            )
            data = client.login()
        except Exception as e:
            flash(f"Connection failed: {e}", 'danger')
            return render_template('login.html')

        session['authenticated'] = True
        session['server_host'] = host
        session['server_port'] = port
        session['db_name'] = db_name
        session['username'] = username
        session['password'] = password
        session['priorities'] = data.get('priorities', [])
        session['divisions'] = data.get('divisions', [])
        session['last_login'] = datetime.now().isoformat()

        try:
            save_user_credentials(username, password)
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning(f"Failed to save credentials for {username}: {e}")

        return redirect(url_for('pages.tasks_page'))

    return render_template('login.html')


@auth_bp.route('/logout')
def logout():
    username = session.get('username', '')
    if username:
        delete_user_subscriptions(username)
        from db import clear_user_cache
        clear_user_cache(username)
    session.clear()
    return _logout_page()


def _logout_page():
    return f'''<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><title>Выход</title>
<style>body{{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1d23;color:#ccc;}}</style>
</head>
<body>
<div style="text-align:center"><p>Очистка кеша...</p></div>
<script>
(function(){{
  try{{localStorage.clear();sessionStorage.clear();}}catch(e){{}}
  if('caches' in window){{
    caches.keys().then(function(keys){{
      return Promise.all(keys.map(function(k){{return caches.delete(k);}}));
    }}).then(function(){{
      if('serviceWorker' in navigator){{
        navigator.serviceWorker.getRegistrations().then(function(regs){{
          return Promise.all(regs.map(function(r){{return r.unregister();}}));
        }}).then(function(){{
          window.location.href='/login';
        }}).catch(function(){{
          window.location.href='/login';
        }});
      }}else{{
        window.location.href='/login';
      }}
    }}).catch(function(){{
      window.location.href='/login';
    }});
  }}else{{
    window.location.href='/login';
  }}
}})();
</script>
</body>
</html>'''
