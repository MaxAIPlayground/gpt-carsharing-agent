# GPT Carsharing Agent (using ChatGPT 4)

This project demonstrates the use of an API wrapper in tandem with a custom ChatGPT action. By managing the API wrapper, you gain complete control over the requests and responses exchanged with a third-party API. This approach is perfect for scenarios where specific response formats are crucial, or when you need precise control over the filtering and structuring of responses.

The full article can be found here:
https://maxaiplayground.github.io/custom-gpt-carsharing-agent/

1. Install packages via `npm install`
2. Create an `.env` environment configuration with these variables:
```
GPT_PORT=
GPT_X_API_KEY=
GPT_USERNAME=
GPT_PASSWORD=
```
3. Run the script with `node gpt-serve.js`

Make sure to run the script in the background on a web server as a daemon, e.g. via supervisor.

This is an example configuration:
```
[program:my-gpt-daemon]
directory=/home/user/gpt/gpt-serve.js
command=node gpt-serve.js
autostart=true
autorestart=true
environment=NODE_ENV=production
```

Errors are logged via winston to `error.log`.
