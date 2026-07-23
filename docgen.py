import os
import re
import uuid
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

    def export_to_pdf(self, ods_path: str, pdf_path: str, lo_dir: str = None):
        if not os.path.exists(ods_path):
            raise FileNotFoundError(f"ODS not found: {ods_path}")
        os.makedirs(os.path.dirname(pdf_path), exist_ok=True)

        if not lo_dir:
            lo_dir = os.path.join(tempfile.gettempdir(), f'lo-{uuid.uuid4().hex[:12]}')
        os.makedirs(lo_dir, exist_ok=True)

        import subprocess
        env = os.environ.copy()
        env['HOME'] = lo_dir
        result = subprocess.run(
            ['libreoffice', '--headless', '--norestore',
             f'-env:UserInstallation=file:///{lo_dir}',
             '--convert-to', 'pdf', '--outdir', os.path.dirname(pdf_path), ods_path],
            capture_output=True, text=True, timeout=180, env=env
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
        NS_TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'
        def merge_adjacent_spans(parent):
            children = list(parent)
            i = 0
            while i < len(children) - 1:
                c = children[i]
                n = children[i+1]
                if (c.tag == n.tag
                        and c.tag == f'{{{NS_TEXT}}}span'
                        and c.get(f'{{{NS_TEXT}}}style-name') == n.get(f'{{{NS_TEXT}}}style-name')):
                    c.text = (c.text or '') + (n.text or '')
                    parent.remove(n)
                    children = list(parent)
                else:
                    merge_adjacent_spans(c)
                    i += 1
            if children:
                merge_adjacent_spans(children[-1])
        merge_adjacent_spans(root)
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

    if not result['zd']:
        m = re.search(r'([А-ЯЁ]{2}-\d{6})(?=[,\s])', text)
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


def build_replacements(parsed: dict, profile_name: str = '', doc_date: str = None) -> dict:
    if doc_date:
        now = datetime.strptime(doc_date, '%Y-%m-%d')
    else:
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
        '{TV4}': parsed.get('tv4', ''),
        '{SN4}': parsed.get('sn4', ''),
        '{TV5}': parsed.get('tv5', ''),
        '{SN5}': parsed.get('sn5', ''),
        '{DS1}': (parsed.get('tv1', '') + ' ' + parsed.get('sn1', '')).strip(),
        '{DS2}': (parsed.get('tv2', '') + ' ' + parsed.get('sn2', '')).strip(),
        '{DS3}': (parsed.get('tv3', '') + ' ' + parsed.get('sn3', '')).strip(),
        '{DS4}': (parsed.get('tv4', '') + ' ' + parsed.get('sn4', '')).strip(),
        '{DS5}': (parsed.get('tv5', '') + ' ' + parsed.get('sn5', '')).strip(),
        '{TV6}': parsed.get('tv6', ''),
        '{SN6}': parsed.get('sn6', ''),
        '{TV7}': parsed.get('tv7', ''),
        '{SN7}': parsed.get('sn7', ''),
        '{TV8}': parsed.get('tv8', ''),
        '{SN8}': parsed.get('sn8', ''),
        '{TV9}': parsed.get('tv9', ''),
        '{SN9}': parsed.get('sn9', ''),
        '{TV10}': parsed.get('tv10', ''),
        '{SN10}': parsed.get('sn10', ''),
        '{DS6}': (parsed.get('tv6', '') + ' ' + parsed.get('sn6', '')).strip(),
        '{DS7}': (parsed.get('tv7', '') + ' ' + parsed.get('sn7', '')).strip(),
        '{DS8}': (parsed.get('tv8', '') + ' ' + parsed.get('sn8', '')).strip(),
        '{DS9}': (parsed.get('tv9', '') + ' ' + parsed.get('sn9', '')).strip(),
        '{DS10}': (parsed.get('tv10', '') + ' ' + parsed.get('sn10', '')).strip(),
        '{DN6}': (parsed.get('tv6', '') + ' ' + parsed.get('sn6', '')).strip(),
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


def generate_act(repl: dict, out_dir: str = None, lo_dir: str = None,
                 items_count: int = 0) -> str:
    out_dir = out_dir or OUT_DIR
    repl = repl.copy()
    if items_count > 7:
        for key in list(repl.keys()):
            if key.startswith('{DS') or key.startswith('{DN'):
                repl[key] = ''
        repl['{DS1}'] = 'Оборудование согласно форме документа М15'
    with tempfile.NamedTemporaryFile(suffix=".ods", delete=False) as tmp:
        ods_path = tmp.name
    pdf_path = os.path.join(out_dir, f"{repl['{NUM}']}-{repl['{SAP}']}-ACT-{uuid.uuid4().hex[:8]}.pdf")
    try:
        filler = ODSFiller()
        filler.fill_and_save(TEMPLATE_ACT, ods_path, repl)
        filler.export_to_pdf(ods_path, pdf_path, lo_dir)
        return pdf_path
    finally:
        if os.path.exists(ods_path):
            os.unlink(ods_path)


def generate_fn(repl: dict, out_dir: str = None, lo_dir: str = None) -> str:
    out_dir = out_dir or OUT_DIR
    with tempfile.NamedTemporaryFile(suffix=".ods", delete=False) as tmp:
        ods_path = tmp.name
    pdf_path = os.path.join(out_dir, f"{repl['{NUM}']}-{repl['{SAP}']}-FN-{uuid.uuid4().hex[:8]}.pdf")
    try:
        filler = ODSFiller()
        filler.fill_and_save(TEMPLATE_FN, ods_path, repl)
        filler.export_to_pdf(ods_path, pdf_path, lo_dir)
        return pdf_path
    finally:
        if os.path.exists(ods_path):
            os.unlink(ods_path)


def generate_m15(repl: dict, is_p: bool, in_value_for_in: Optional[str] = None, in_value_for_out: Optional[str] = None, out_dir: str = None, lo_dir: str = None, doc_date: str = None) -> list:
    out_dir = out_dir or OUT_DIR
    if doc_date:
        dt = datetime.strptime(doc_date, '%Y-%m-%d')
        repl['{DATE}'] = dt.strftime('%d.%m.%Y')
    else:
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
        pdf_path = os.path.join(out_dir, f"{current_repl['{NUM}']}-{current_repl['{SAP}']}-{suffix}-{uuid.uuid4().hex[:8]}.pdf")
        try:
            filler = ODSFiller()
            filler.fill_and_save(template, ods_path, current_repl)
            filler.export_to_pdf(ods_path, pdf_path, lo_dir)
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
    out_dir = tempfile.mkdtemp(prefix='mrc_doc_')
    lo_dir = os.path.join(out_dir, 'lo')
    os.makedirs(lo_dir, exist_ok=True)
    parsed = extract_task_data(task)
    shop = parsed.get('shop', '')
    sap = parsed.get('sap', '')
    addr = parsed.get('addr', '')

    from db import find_shop_by_number, find_shop_by_sap, add_shop_if_not_exists

    if sap:
        db_entry = find_shop_by_sap(sap)
        if db_entry:
            shop, sap, addr = db_entry[:3]
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
    items = field_overrides.get('items') if field_overrides else None
    if field_overrides:
        # Product items for TV/SN placeholders
        if items:
            for i, item in enumerate(items[:20], 1):
                parsed[f'tv{i}'] = item.get('name', '')
                parsed[f'sn{i}'] = item.get('series', '')

        for key in ('shop', 'sap', 'addr', 'desc', 'code', 'zd'):
            val = field_overrides.get(key)
            if val:
                parsed[key] = str(val)
        # Re-derive rvr/dop from possibly overridden code
        code = parsed.get('code', '')
        parsed['rvr'] = 'V' if code.startswith('ИНЦ-') else ''
        parsed['dop'] = 'V' if code.startswith('ЗНО-') else ''

    doc_date = field_overrides.get('doc_date') if field_overrides else None

    if not parsed.get('sap'):
        raise ValueError("Не удалось определить SAP-код магазина")

    code = parsed.get('code', '')
    is_p = code.startswith('ЗНО-')

    repl = build_replacements(parsed, profile_name, doc_date)
    temp_files = []
    attachments = []

    try:
        if include_act:
            items_count = len(items) if items else 0
            act_pdf = generate_act(repl, out_dir, lo_dir, items_count)
            temp_files.append(act_pdf)
            attachments.append(act_pdf)

        if include_fn:
            fn_pdf = generate_fn(repl, out_dir, lo_dir)
            temp_files.append(fn_pdf)
            attachments.append(fn_pdf)

        if include_m15:
            items_count = len(items) if items else 0
            needs_chunking = items_count > 10
            all_m15_pdfs = []
            if needs_chunking:
                for chunk_start in range(0, items_count, 10):
                    chunk_repl = repl.copy()
                    if is_p:
                        chunk_repl['{MVZ}'] = 'X0UGSMW6'
                    for j in range(1, 11):
                        idx = chunk_start + j - 1
                        if idx < items_count:
                            chunk_repl[f'{{TV{j}}}'] = items[idx].get('name', '')
                            chunk_repl[f'{{SN{j}}}'] = items[idx].get('series', '')
                        else:
                            chunk_repl[f'{{TV{j}}}'] = ''
                            chunk_repl[f'{{SN{j}}}'] = ''
                    with tempfile.NamedTemporaryFile(suffix=".ods", delete=False) as tmp:
                        ods_path = tmp.name
                    pdf_path = os.path.join(out_dir, f"{chunk_repl['{NUM}']}-{chunk_repl['{SAP}']}-FWD-{uuid.uuid4().hex[:8]}.pdf")
                    try:
                        filler = ODSFiller()
                        filler.fill_and_save(TEMPLATE_M15_OUT, ods_path, chunk_repl)
                        filler.export_to_pdf(ods_path, pdf_path, lo_dir)
                        temp_files.append(pdf_path)
                        all_m15_pdfs.append(pdf_path)
                    finally:
                        if os.path.exists(ods_path):
                            os.unlink(ods_path)
                rev_repl = repl.copy()
                if is_p:
                    rev_repl['{MVZ}'] = 'X0UGSMW6'
                with tempfile.NamedTemporaryFile(suffix=".ods", delete=False) as tmp:
                    ods_path = tmp.name
                pdf_path = os.path.join(out_dir, f"{rev_repl['{NUM}']}-{rev_repl['{SAP}']}-REV-{uuid.uuid4().hex[:8]}.pdf")
                try:
                    filler = ODSFiller()
                    filler.fill_and_save(TEMPLATE_M15_IN, ods_path, rev_repl)
                    filler.export_to_pdf(ods_path, pdf_path, lo_dir)
                    temp_files.append(pdf_path)
                    all_m15_pdfs.append(pdf_path)
                finally:
                    if os.path.exists(ods_path):
                        os.unlink(ods_path)
            else:
                if is_p:
                    repl['{MVZ}'] = 'X0UGSMW6'
                m15_pdfs = generate_m15(repl, is_p, out_dir=out_dir, lo_dir=lo_dir, doc_date=doc_date)
                all_m15_pdfs.extend(m15_pdfs)
                temp_files.extend(m15_pdfs)
            m15_combined = os.path.join(out_dir, f"{repl['{NUM}']}-{repl['{SAP}']}-M15-{uuid.uuid4().hex[:8]}.pdf")
            merge_pdfs_with_rotation(all_m15_pdfs, m15_combined)
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
