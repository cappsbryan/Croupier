import os
import urllib.parse
from enum import Enum

import psycopg2
from dotenv import load_dotenv

import gdrive

load_dotenv()

gdrive.init_drive_service()


def get_env_variable(name, default=None):
    if default is not None:
        return os.getenv(name, default)
    result = os.getenv(name)
    if result is None:
        raise EnvironmentError(f'Environment variable {name} not set. Please see README.')
    return result


keyword = get_env_variable('CROUPIER_KEYWORD', 'post')
test = get_env_variable('CROUPIER_TEST_MODE', 'true').lower() != 'false'


class StorageService(Enum):
    DROPBOX = 1
    GDRIVE = 2


storage_service = get_env_variable('CROUPIER_STORAGE_SERVICE')
if storage_service.lower() == 'dropbox':
    storage_service = StorageService.DROPBOX
    dropbox_key = get_env_variable('CROUPIER_DROPBOX_KEY')
elif storage_service.lower() in ['gdrive', 'googledrive', 'google']:
    storage_service = StorageService.GDRIVE
    pass
else:
    raise EnvironmentError('Unknown CROUPIER_STORAGE_SERVICE value')

folder_path = get_env_variable('CROUPIER_FOLDER_PATH')

groupme_token = get_env_variable('CROUPIER_GROUPME_TOKEN')
groupme_image_url = get_env_variable('CROUPIER_GROUPME_IMAGE_URL')
groupme_post_url = get_env_variable('CROUPIER_GROUPME_POST_URL')
groupme_bot_id = get_env_variable('CROUPIER_GROUPME_BOT_ID')

not_found_link = get_env_variable('CROUPIER_NOT_FOUND_LINK')

database_url = os.getenv('DATABASE_URL')


def connect_to_db():
    urllib.parse.uses_netloc.append('postgres')
    url = urllib.parse.urlparse(database_url)
    conn = psycopg2.connect(
        database=url.path[1:],
        user=url.username,
        password=url.password,
        host=url.hostname,
        port=url.port
    )
    return conn


names = {}

conn = connect_to_db()
with conn.cursor() as c:
    c.execute('SELECT original, replacement FROM names')
    records = c.fetchall()
    names.update(records)
conn.close()
