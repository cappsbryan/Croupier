#!/usr/bin/env python3

import datetime
import math
import os
import random
import urllib.parse

import dropbox
import psycopg2
import requests

import constants

dateformat = '%Y-%m-%d %H:%M:%S.%f'
test = False


def current_time():
    return datetime.datetime.now()


def get_picture_path(dbx, search=None):
    folder = dbx.files_list_folder(constants.dropbox_path)
    items = folder.entries
    if search and search != 'anybody' and search != 'any' and search != '':
        search = search.lower()
        words = search.split()
        items = filter_by_all_words(items, words)
    items = weighted_list_of_files(items)
    if items:
        path = random.choice(items).path_lower
        write_to_db(path)
        return path


def get_temp_dropbox_image_link(search=None):
    dbx = dropbox.Dropbox(constants.dropbox_key)
    path = get_picture_path(dbx, search)
    if not path:
        return None
    temp_link = dbx.files_get_temporary_link(path)
    return temp_link


def filter_by_all_words(items, words):
    new_items = list()
    for item in items:
        include = True
        for keyword in words:
            if keyword not in item.name.lower():
                include = False
                break
        if include:
            new_items.append(item)
    return new_items


def upload_to_groupme_image_service(link):
    image = requests.get(link)
    headers = {'X-Access-Token': constants.groupme_token}
    response = requests.post(constants.groupme_image_url, data=image, headers=headers)
    json = response.json()
    url = json['payload']['url']
    return url


def post_image_to_groupme(link):
    body = {"bot_id": constants.groupme_bot_id, "attachments": [{"type": "image", "url": link}]}
    if not test:
        requests.post(constants.groupme_post_url, json=body)
    return body


def post_random_dropbox_picture_to_groupme():
    post_picture()


def post_not_found_image():
    link = constants.not_found_link
    groupme_link = upload_to_groupme_image_service(link)
    return post_image_to_groupme(groupme_link)


def post_picture(search=None):
    dropbox_link = get_temp_dropbox_image_link(search)
    if dropbox_link:
        dropbox_link = dropbox_link.link
    else:
        return
    groupme_link = upload_to_groupme_image_service(dropbox_link)
    return post_image_to_groupme(groupme_link)


def weighted_list_of_files(unweighted):
    weighted = []
    conn = connect_to_db()
    c = conn.cursor()
    for item in unweighted:
        path = item.path_lower
        c.execute('SELECT * FROM posts WHERE path=%s', (path,))
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
    conn = connect_to_db()
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


def connect_to_db():
    urllib.parse.uses_netloc.append("postgres")
    url = urllib.parse.urlparse(os.environ["DATABASE_URL"])
    conn = psycopg2.connect(
        database=url.path[1:],
        user=url.username,
        password=url.password,
        host=url.hostname,
        port=url.port
    )
    return conn


if __name__ == '__main__':
    post_random_dropbox_picture_to_groupme()
