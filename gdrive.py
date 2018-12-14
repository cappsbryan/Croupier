import json
import os

import httplib2
from dotenv import load_dotenv
from googleapiclient import discovery
from oauth2client.service_account import ServiceAccountCredentials

drive_service = None


def init_drive_service():
    global drive_service
    load_dotenv()

    # use creds to create a client to interact with the Google Drive API
    scope = ['https://www.googleapis.com/auth/drive']
    creds = ServiceAccountCredentials.from_json_keyfile_dict(
        json.loads(os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')), scope)

    http = creds.authorize(httplib2.Http())
    drive_service = discovery.build('drive', 'v3', http=http, cache_discovery=False)
