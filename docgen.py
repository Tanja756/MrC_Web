import os
import re
import zipfile
import xml.etree.ElementTree as ET
import tempfile
import logging
from datetime import datetime
from typing import Optional
from pypdf import PdfReader, PdfWriter

logger = logging.getLogger(__name__)

TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), 'templates_docs')
OUT_DIR = os.path.join(os.path.dirname(__file__), 'out_doc')
os.makedirs(OUT_DIR, exist_ok=True)

TEMPLATE_ACT = os.path.join(TEMPLATES_DIR, "АВР.ods")
TEMPLATE_FN = os.path.join(TEMPLATES_DIR, "ФН.ods")
TEMPLATE_M15_IN = os.path.join(TEMPLATES_DIR, "M15_Обратная.ods")
TEMPLATE_M15_OUT = os.path.join(TEMPLATES_DIR, "M15_Прямая.ods")


class ODSFiller:
    def fill_and_save(self, template_path: str, output_path: str, replacements: dict):
        if not os.path.exists(template_path):
            raise FileNotFoundError(f"Template not found: {template_path}")
        with tempfile.TemporaryDirectory() as temp_dir:
            content_path = self._extract_and_fill_content(
                template_path, temp_dir, replacements
            )
            self._repack_ods(template_path, output_path, content_path)

    def export_to_pdf(self, ods_path: str, pdf_path: str):
        if not os.path.exists(ods_path):
            raise FileNotFoundError(f"ODS not found: {ods_path}")
        os.makedirs(os.path.dirname(pdf_path), exist_ok=True)

        import subprocess
        env = os.environ.copy()
        env['HOME'] = '/tmp'
        result = subprocess.run(
            ['libreoffice', '--headless', '--norestore',
             f'-env:UserInstallation=file:///tmp/lu-{os.getpid()}',
             '--convert-to', 'pdf', '--outdir', os.path.dirname(pdf_path), ods_path],
            capture_output=True, text=True, timeout=60, env=env
        )
        if result.returncode != 0:
            msg = (result.stderr or '').strip() or (result.stdout or '').strip() or f'LibreOffice exit code {result.returncode}'
            raise RuntimeError(f"LibreOffice error: {msg}")

        expected = os.path.join(os.path.dirname(pdf_path), os.path.splitext(os.path.basename(ods_path))[0] + '.pdf')
        if os.path.exists(expected) and expected != pdf_path:
            os.rename(expected, pdf_path)

        if not os.path.exists(pdf_path) or os.path.getsize(pdf_path) < 1000:
            raise RuntimeError("PDF not created or empty")
        return pdf_path

    def _connect_desktop(self):
        import uno
        from com.sun.star.connection import NoConnectException

        try:
            local_context = uno.getComponentContext()
            resolver = local_context.ServiceManager.createInstanceWithContext(
                "com.sun.star.bridge.UnoUrlResolver", local_context
            )
            context = resolver.resolve(self.UNO_URL)
            service_manager = context.ServiceManager
            return service_manager.createInstanceWithContext(
                "com.sun.star.frame.Desktop", context
            )
        except NoConnectException:
            raise ConnectionError(
                "LibreOffice not running.\n"
                "Run: libreoffice --headless "
                "--accept=\"socket,host=localhost,port=2002;urp;StarOffice.NamingService\""
            )

    @staticmethod
    def _replace_text_recursive(element, replacements):
        if element.text:
            new_text = element.text
            for placeholder, value in replacements.items():
                new_text = new_text.replace(placeholder, str(value or ""))
            if new_text != element.text:
                element.text = new_text
        for child in element:
            ODSFiller._replace_text_recursive(child, replacements)
            if child.tail:
                new_tail = child.tail
                for placeholder, value in replacements.items():
                    new_tail = new_tail.replace(placeholder, str(value or ""))
                if new_tail != child.tail:
                    child.tail = new_tail

    def _extract_and_fill_content(self, template_path, temp_dir, replacements):
        with zipfile.ZipFile(template_path, 'r') as zip_in:
            zip_in.extract('content.xml', temp_dir)
        content_path = os.path.join(temp_dir, 'content.xml')
        tree = ET.parse(content_path)
        root = tree.getroot()
        self._replace_text_recursive(root, replacements)
        tree.write(content_path, encoding='utf-8', xml_declaration=True)
        return content_path

    def _repack_ods(self, template_path, output_path, content_path):
        with zipfile.ZipFile(template_path, 'r') as zip_in:
            with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zip_out:
                for item in zip_in.infolist():
                    if item.filename == 'content.xml':
                        zip_out.write(content_path, 'content.xml')
                    else:
                        zip_out.writestr(item, zip_in.read(item.filename))


def extract_task_data(task: dict) -> dict:
    text = (task.get('name') or '') + '\n' + (task.get('description') or '')
    result = {'shop': '', 'sap': '', 'addr': '', 'desc': '', 'code': '', 'rvr': '', 'dop': '', 'zd': '', 'tel': ''}

    is_structured = bool(re.search(r'Номер:\s|Код заявки:\s|Объект обслуживания:\s', text))

    m = re.search(r'Номер:\s*([^\s]+)', text)
    if m:
        result['zd'] = m.group(1)
    m = re.search(r'Код заявки:\s*([^\s]+)', text)
    if m:
        code = m.group(1)
        result['code'] = code
        result['rvr'] = 'V' if code.startswith('ИНЦ-') else ''
        result['dop'] = 'V' if code.startswith('ЗНО-') else ''

    # Structured format: Объект обслуживания: 14908-Пятерочка SAP-O055
    m = re.search(r'Объект\s*обслуживания:\s*(\d+)-Пятерочка\s+SAP-(\S+)', text)
    if m:
        result['shop'] = m.group(1)
        result['sap'] = m.group(2).upper()
    else:
        # Compact format: 20648-Пятерочка SAP-31X2
        m = re.search(r'(\d+)-Пятерочка\s+SAP-(\S+)', text)
        if m:
            result['shop'] = m.group(1)
            result['sap'] = m.group(2).upper()
        else:
            m = re.search(r'Объект\s*обслуживания:\s*(\d+)-', text)
            if m:
                result['shop'] = m.group(1)
            m = re.search(r'SAP-(\w+)', text)
            if m:
                result['sap'] = m.group(1).upper()

    m = re.search(r'Адрес:\s*(.*)$', text, re.MULTILINE)
    if m:
        result['addr'] = m.group(1).strip()
    if not result['addr'] and result['sap']:
        # Address after SAP code until pipe or end of shop block
        m = re.search(r'SAP-\w+\s+(.*?)(?:\s*\||$)', text)
        if m:
            addr = m.group(1).strip()
            addr = re.sub(r'\s*(Контрагент:|Срок:).*$', '', addr).strip()
            if addr:
                result['addr'] = addr

    # Description only from structured format or task.description field
    if is_structured:
        desc = (task.get('description') or '').strip()
        if desc:
            result['desc'] = re.sub(r'\s*(Контрагент:|Срок:).*$', '', desc).strip()
        if not result['desc']:
            m = re.search(r'Подробное\s*описание:\s*\n?(.*?)(?:\n\n\*\*\*|\n\n|$)', text, re.DOTALL)
            if m:
                desc = m.group(1).strip()
                desc = re.sub(r'\s*(Контрагент:|Срок:).*$', '', desc).strip()
                if desc:
                    result['desc'] = desc
        if not result['desc']:
            m = re.search(r'\|\s*(.*?)\s*\|', text)
            if m:
                desc = m.group(1).strip()
                desc = re.sub(r'\s*(Контрагент:|Срок:).*$', '', desc).strip()
                if desc:
                    result['desc'] = desc

    return result


def build_replacements(parsed: dict, profile_name: str = '') -> dict:
    now = datetime.now()
    repl = {
        '{D1}': now.strftime('%d')[0], '{D0}': now.strftime('%d')[1],
        '{M1}': now.strftime('%m')[0], '{M0}': now.strftime('%m')[1],
        '{Y3}': now.strftime('%Y')[0], '{Y2}': now.strftime('%Y')[1],
        '{Y1}': now.strftime('%Y')[2], '{Y0}': now.strftime('%Y')[3],
        '{H1}': now.strftime('%H')[0], '{H0}': now.strftime('%H')[1],
        '{DATE}': now.strftime('%d.%m.%Y'),
        '{KA}': profile_name or '',
        '{MVZ}': 'X0UGSMP4',
        '{RVR}': parsed.get('rvr', ''),
        '{DOP}': parsed.get('dop', ''),
        '{DESC}': parsed.get('desc', ''),
        '{ZD}': parsed.get('zd', ''),
        '{IN}': parsed.get('code', ''),
        '{TV1}': parsed.get('tv1', ''),
        '{SN1}': parsed.get('sn1', ''),
        '{TV2}': parsed.get('tv2', ''),
        '{SN2}': parsed.get('sn2', ''),
        '{TV3}': parsed.get('tv3', ''),
        '{SN3}': parsed.get('sn3', ''),
    }
    shop = parsed.get('shop', '')
    sap = parsed.get('sap', '')
    addr = parsed.get('addr', '')
    padded_shop = shop.rjust(5)
    padded_sap = sap.ljust(4)[:4]
    repl.update({
        '{NUM}': shop,
        '{SHOP}': f"{shop}, {addr}" if shop and addr else shop or addr,
        '{SAP}': sap,
        '{ADDR}': addr,
        '{N0}': padded_shop[0], '{N1}': padded_shop[1],
        '{N2}': padded_shop[2], '{N3}': padded_shop[3], '{N4}': padded_shop[4],
        '{S0}': padded_sap[0], '{S1}': padded_sap[1],
        '{S2}': padded_sap[2], '{S3}': padded_sap[3],
    })
    return repl


def generate_act(repl: dict) -> str:
    with tempfile.NamedTemporaryFile(suffix=".ods", delete=False) as tmp:
        ods_path = tmp.name
    pdf_path = os.path.join(OUT_DIR, f"{repl['{NUM}']}-{repl['{SAP}']}-ACT-{datetime.now():%Y%m%d%H%M%S}.pdf")
    try:
        filler = ODSFiller()
        filler.fill_and_save(TEMPLATE_ACT, ods_path, repl)
        filler.export_to_pdf(ods_path, pdf_path)
        return pdf_path
    finally:
        if os.path.exists(ods_path):
            os.unlink(ods_path)


def generate_fn(repl: dict) -> str:
    with tempfile.NamedTemporaryFile(suffix=".ods", delete=False) as tmp:
        ods_path = tmp.name
    pdf_path = os.path.join(OUT_DIR, f"{repl['{NUM}']}-{repl['{SAP}']}-FN-{datetime.now():%Y%m%d%H%M%S}.pdf")
    try:
        filler = ODSFiller()
        filler.fill_and_save(TEMPLATE_FN, ods_path, repl)
        filler.export_to_pdf(ods_path, pdf_path)
        return pdf_path
    finally:
        if os.path.exists(ods_path):
            os.unlink(ods_path)


def generate_m15(repl: dict, is_p: bool, in_value_for_in: Optional[str] = None, in_value_for_out: Optional[str] = None) -> list:
    repl['{DATE}'] = datetime.now().strftime('%d.%m.%Y')
    pdf_files = []
    templates = [
        (TEMPLATE_M15_IN, "IN", in_value_for_in),
        (TEMPLATE_M15_OUT, "OUT-P" if is_p else "OUT", in_value_for_out),
    ]
    for template, suffix, override_in in templates:
        current_repl = repl.copy()
        if override_in is not None:
            current_repl['{IN}'] = override_in
        with tempfile.NamedTemporaryFile(suffix=".ods", delete=False) as tmp:
            ods_path = tmp.name
        pdf_path = os.path.join(OUT_DIR, f"{current_repl['{NUM}']}-{current_repl['{SAP}']}-{suffix}-{datetime.now():%Y%m%d%H%M%S}.pdf")
        try:
            filler = ODSFiller()
            filler.fill_and_save(template, ods_path, current_repl)
            filler.export_to_pdf(ods_path, pdf_path)
            pdf_files.append(pdf_path)
        finally:
            if os.path.exists(ods_path):
                os.unlink(ods_path)
    return pdf_files


def merge_pdfs_with_rotation(pdf_paths: list, output_path: str) -> None:
    writer = PdfWriter()
    try:
        for path in pdf_paths:
            if not os.path.exists(path):
                continue
            reader = PdfReader(path)
            for page in reader.pages:
                box = page.mediabox
                if float(box.width) > float(box.height):
                    page.rotate(90)
                writer.add_page(page)
        with open(output_path, "wb") as f_out:
            writer.write(f_out)
    finally:
        writer.close()


def generate_documents(task: dict, profile_name: str = '',
                       include_act: bool = True, include_fn: bool = True,
                       include_m15: bool = True,
                       field_overrides: dict = None) -> list:
    for f in os.listdir(OUT_DIR):
        fp = os.path.join(OUT_DIR, f)
        if os.path.isfile(fp) and f.endswith('.pdf'):
            os.unlink(fp)
    parsed = extract_task_data(task)
    shop = parsed.get('shop', '')
    sap = parsed.get('sap', '')
    addr = parsed.get('addr', '')

    from db import find_shop_by_number, find_shop_by_sap, add_shop_if_not_exists

    if sap:
        db_entry = find_shop_by_sap(sap)
        if db_entry:
            shop, sap, addr = db_entry
            parsed['desc'] = ''

    if not shop or not shop.isdigit():
        if not sap:
            shop = '0'
        else:
            shop = '0'
            parsed['desc'] = ''
        parsed['shop'] = shop
        parsed['addr'] = addr or ''

    parsed['shop'] = shop
    parsed['sap'] = sap
    parsed['addr'] = addr

    if sap and addr and shop.isdigit():
        add_shop_if_not_exists(shop, sap, addr)

    # Apply field overrides from the form (override extracted/DB values)
    if field_overrides:
        # Product items for TV/SN placeholders
        items = field_overrides.get('items')
        if items:
            for i, item in enumerate(items[:3], 1):
                parsed[f'tv{i}'] = item.get('name', '')
                parsed[f'sn{i}'] = item.get('series', '')

        for key in ('shop', 'sap', 'addr', 'desc', 'code', 'zd'):
            val = field_overrides.get(key)
            if val is not None:
                parsed[key] = str(val)
        # Re-derive rvr/dop from possibly overridden code
        code = parsed.get('code', '')
        parsed['rvr'] = 'V' if code.startswith('ИНЦ-') else ''
        parsed['dop'] = 'V' if code.startswith('ЗНО-') else ''

    if not parsed.get('sap'):
        raise ValueError("Не удалось определить SAP-код магазина")

    code = parsed.get('code', '')
    is_p = code.startswith('ЗНО-')

    repl = build_replacements(parsed, profile_name)
    temp_files = []
    attachments = []

    try:
        if include_act:
            act_pdf = generate_act(repl)
            temp_files.append(act_pdf)
            attachments.append(act_pdf)

        if include_fn:
            fn_pdf = generate_fn(repl)
            temp_files.append(fn_pdf)
            attachments.append(fn_pdf)

        if include_m15:
            if is_p:
                repl['{MVZ}'] = 'X0UGSMW6'
            m15_pdfs = generate_m15(repl, is_p)
            temp_files.extend(m15_pdfs)
            m15_combined = os.path.join(OUT_DIR, f"{repl['{NUM}']}-{repl['{SAP}']}-M15-{datetime.now():%Y%m%d%H%M%S}.pdf")
            merge_pdfs_with_rotation(m15_pdfs, m15_combined)
            temp_files.append(m15_combined)
            attachments.append(m15_combined)

        return attachments
    except Exception:
        for f in temp_files:
            if f and os.path.exists(f):
                try:
                    os.unlink(f)
                except Exception:
                    pass
        raise
