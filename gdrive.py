import json
import os

import httplib2
from dotenv import load_dotenv
from googleapiclient.discovery import build
from oauth2client.service_account import ServiceAccountCredentials

drive_service = None


def init_drive_service():
    global drive_service
    load_dotenv()

    # use creds to create a client to interact with the Google Drive API
    scopes = ['https://www.googleapis.com/auth/drive']
    config_json_string = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
    config_json = json.loads(config_json_string)
    creds = ServiceAccountCredentials.from_json_keyfile_dict(config_json, scopes=scopes)

    drive_service = build('drive', 'v3', credentials=creds)
