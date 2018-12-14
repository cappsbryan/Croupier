#!/usr/bin/env python3

import datetime
import math
import random

import dropbox
import requests

import settings
from gdrive import drive_service

dateformat = '%Y-%m-%d %H:%M:%S.%f'


def current_time():
    return datetime.datetime.now()


def pick_random_picture(items, search=None):
    if search and search != 'anybody' and search != 'any' and search != '':
        search = search.lower()
        words = search.split()
        items = filter_by_all_words(items, words)
    items = weighted_list_of_files(items)
    if items:
        item = random.choice(items)
        write_to_db(item)
        return item


def get_temp_dropbox_image_link(search=None):
    dbx = dropbox.Dropbox(settings.dropbox_key)
    folder = dbx.files_list_folder(settings.folder_path)
    items = [entry.name for entry in folder.entries]
    item = pick_random_picture(items, search)
    if not item:
        return None
    temp_link = dbx.files_get_temporary_link(settings.folder_path + '/' + item)
    return temp_link.link


def get_gdrive_image(search=None):
    items = get_gdrive_files()
    name = pick_random_picture(items, search)
    if not name:
        return None
    response = drive_service.files().list(q=f"name contains '{name}'").execute()
    id = response['files'][0]['id']
    response = drive_service.files().get_media(fileId=id).execute()
    return response


def get_gdrive_folder_id():
    folder = settings.folder_path.split('/')[-1]
    query = f'name = \'{folder}\' and mimeType = \'application/vnd.google-apps.folder\''
    response = drive_service.files().list(q=query).execute()
    return response['files'][0]['id']


def get_gdrive_files():
    folder_id = get_gdrive_folder_id()
    page_token = None
    files = []
    while True:
        response = drive_service.files().list(q=f"'{folder_id}' in parents",
                                              pageToken=page_token).execute()
        for file in response.get('files', []):
            if file['mimeType'] == 'image/png':
                files.append(file['name'])
        page_token = response.get('nextPageToken', None)
        if page_token is None:
            break
    return files


def filter_by_all_words(items, words):
    new_items = list()
    for item in items:
        include = True
        for keyword in words:
            if keyword not in item.lower():
                include = False
                break
        if include:
            new_items.append(item)
    return new_items


def upload_link_to_groupme_image_service(link):
    image = requests.get(link)
    return upload_data_to_groupme_image_service(image.content)


def upload_data_to_groupme_image_service(data):
    headers = {'X-Access-Token': settings.groupme_token}
    response = requests.post(settings.groupme_image_url, data=data, headers=headers)
    json = response.json()
    url = json['payload']['url']
    return url


def post_image_to_groupme(link):
    body = {"bot_id": settings.groupme_bot_id, "attachments": [{"type": "image", "url": link}]}
    if not settings.test:
        requests.post(settings.groupme_post_url, json=body)
    return body


def post_random_dropbox_picture_to_groupme():
    post_picture()


def post_not_found_image():
    link = settings.not_found_link
    groupme_link = upload_link_to_groupme_image_service(link)
    return post_image_to_groupme(groupme_link)


def post_picture(search=None):
    groupme_link = None
    if settings.storage_service == settings.StorageService.DROPBOX:
        link = get_temp_dropbox_image_link(search)
        groupme_link = upload_link_to_groupme_image_service(link)
    elif settings.storage_service == settings.StorageService.GDRIVE:
        image_data = get_gdrive_image(search)
        groupme_link = upload_data_to_groupme_image_service(image_data)
    return post_image_to_groupme(groupme_link)


def weighted_list_of_files(unweighted):
    weighted = []
    conn = settings.connect_to_db()
    c = conn.cursor()
    for item in unweighted:
        c.execute('SELECT * FROM posts WHERE path=%s', (item,))
        result = c.fetchone()
        if result:
            last_posted_date = datetime.datetime.strptime(result[0], dateformat)
            delta = current_time() - last_posted_date
            days = delta.days if delta.days < 60 else 60
            weighted.extend([item] * math.ceil((days ** 2) / 35))
        else:
            weighted.extend([item] * 103)
    return weighted


def write_to_db(file_path):
    conn = settings.connect_to_db()
    c = conn.cursor()
    date = current_time().strftime(dateformat)
    try:
        c.execute("SELECT * FROM posts WHERE path=%s", (file_path,))
        present = c.fetchone()
        if present:
            c.execute("UPDATE posts SET datetime = %s WHERE path=%s", (date, file_path))
        else:
            c.execute("INSERT INTO posts (datetime, path) VALUES (%s, %s)", (date, file_path))
    finally:
        c.close()
        conn.commit()
        conn.close()


if __name__ == '__main__':
    post_random_dropbox_picture_to_groupme()
