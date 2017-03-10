# Croupier
A GroupMe bot that will post images from a specified Dropbox folder when a configurable keyword is posted in the group.
Optionally, search the image filenames to post from a specific set of images.

Croupier can also be configured to map certain user queries to other filename search queries.

Configuration is set in the constants.py file. Here's an example:

```python
names = {
    'matthew': 'matt_',
    'matt': 'matt_',
    'frank': 'frank_',
    'marky mark': 'mark_',
    'mark': 'mark_'
}

keyword = 'post'

dropbox_key = 'xxxxx-xxxxxxxxxxxxxxxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
dropbox_path = '/path/to/your/images'
groupme_token = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
groupme_image_url = 'https://image.groupme.com/pictures'
groupme_post_url = 'https://api.groupme.com/v3/bots/post'
groupme_bot_id = 'xxxxxxxxxxxxxxxxxxxxxxxxxx'
not_found_link = "https://example.com/your_image_wasnt_found.jpg"
```

The variable `names` is used to specify mappings from user input to image filename search queries.
The line `'matthew': 'matt_',` allows the user to type in "matthew" and Croupier will search for files containing 'matt_'.
This is useful for nicknames and having a naming scheme for your images that your group members do not need to know.

`keyword`: the trigger word for the bot.
The user will need to start their post with the keyword to cause Croupier to post an image.

For example, a user could send a message to the group with the text `post matthew`
and Croupier would then post an image with a filename containing `matt_` to the group.

`dropbox_path`: the path from inside your main Dropbox folder to the images.  
`groupme_image_url` and `groupme_post_url`: urls used to communicate with GroupMe's bot API.  
`not_found_link`: a link to an image that will be posted when Croupier cannot find an image matching a user's query.

The remaining variables are credentials needed to interact with the [GroupMe](https://dev.groupme.com/bots) and [Dropbox](https://www.dropbox.com/developers) APIs.