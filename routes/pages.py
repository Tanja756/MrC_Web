from flask import Blueprint, render_template
from .helpers import login_required

pages_bp = Blueprint('pages', __name__)


@pages_bp.route('/tasks')
@login_required
def tasks_page():
    return render_template('pages/tasks.html', title='Задачи')


@pages_bp.route('/warehouse')
@login_required
def warehouse_page():
    return render_template('pages/warehouse.html', title='Склад')


@pages_bp.route('/salary')
@login_required
def salary_page():
    return render_template('pages/salary.html', title='Зарплата')


@pages_bp.route('/ppr')
@login_required
def ppr_page():
    return render_template('pages/ppr.html', title='ППР')


@pages_bp.route('/route')
@login_required
def route_page():
    return render_template('pages/route.html', title='Маршрутный лист')


@pages_bp.route('/upload')
@login_required
def upload_page():
    return render_template('pages/upload.html', title='Загрузка')


@pages_bp.route('/settings')
@login_required
def settings_page():
    return render_template('pages/settings.html', title='Настройки')
