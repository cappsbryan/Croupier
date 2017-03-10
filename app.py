#!/usr/bin/env python3

import os

from flask import Flask
from flask import request

import constants
import spin

app = Flask(__name__)
test = False


@app.route('/newmessage', methods=['POST'])
def new_message():
    spin.test = test
    json = request.get_json()
    message_text = json['text'].lower()
    if not message_text or constants.keyword != message_text.split()[0]:
        return constants.keyword + " keyword not in message"
    search = ' '.join(message_text.split()[1:])
    already_replaced = []
    for name, replacement in constants.names.items():
        if name in search and replacement not in already_replaced:
            already_replaced.append(constants.names[name])
            search = search.replace(name, constants.names[name])
    result = spin.post_picture(search)
    if result:
        return "Posted: " + str(result)
    else:
        result = spin.post_not_found_image()
        return "No result found: " + str(result)


if __name__ == '__main__':
    if not constants:
        print("constants.py not found")
        print("See README for instructions")
    else:
        port = int(os.environ.get("PORT", 5000))
        app.run(host='0.0.0.0', port=port)
