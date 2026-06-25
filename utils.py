import io
import base64
import logging
from PIL import Image

logger = logging.getLogger(__name__)

MAX_IMAGE_DIMENSION = 1920
QUALITY = 85


def compress_image(base64_data: str, filename: str = '') -> str:
    ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    if ext not in ('jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'):
        return base64_data

    try:
        raw = base64.b64decode(base64_data)
        img = Image.open(io.BytesIO(raw))
        if max(img.width, img.height) <= MAX_IMAGE_DIMENSION:
            return base64_data

        ratio = MAX_IMAGE_DIMENSION / max(img.width, img.height)
        new_size = (int(img.width * ratio), int(img.height * ratio))
        img = img.resize(new_size, Image.LANCZOS)

        out = io.BytesIO()
        save_ext = 'JPEG' if ext in ('jpg', 'jpeg') else ext.upper()
        if save_ext == 'JPG':
            save_ext = 'JPEG'
        img.save(out, format=save_ext, quality=QUALITY)
        compressed = base64.b64encode(out.getvalue()).decode()

        saved = len(base64_data) - len(compressed)
        logger.info(f"compress_image: {filename} {img.width}x{img.height} saved {max(0, saved)} bytes")
        return compressed
    except Exception:
        logger.warning(f"compress_image failed for {filename}, sending original")
        return base64_data


def compress_attachments(attachments: list) -> list:
    for att in attachments:
        data = att.get('data', '')
        if data:
            att['data'] = compress_image(data, att.get('filename', ''))
    return attachments
