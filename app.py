#!/usr/bin/env python3

import os

from flask import Flask
from flask import request

import settings
import spin

app = Flask(__name__)


@app.route('/newmessage', methods=['POST'])
def new_message():
    json = request.get_json()
    message_text = json['text'].lower()
    first_word = message_text.split()[0]
    if not message_text or first_word != settings.keyword:
        return settings.keyword + " keyword not in message"
    search = ' '.join(message_text.split()[1:])
    already_replaced = []
    for name, replacement in settings.names.items():
        if name in search and replacement not in already_replaced:
            already_replaced.append(settings.names[name])
            search = search.replace(name, settings.names[name])
    result = spin.post_picture(search)
    if result:
        return "Posted: " + str(result)
    else:
        result = spin.post_not_found_image()
        return "No result found: " + str(result)


if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port)
