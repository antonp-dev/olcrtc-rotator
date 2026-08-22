# TODO

- [ ] Test the Google login fallback in `rotator/rotate.js` by using an expired or invalid `state.json` session with the optional `GOOGLE_EMAIL`, `GOOGLE_PASSWORD`, and `GOOGLE_TOTP_SECRET` variables. The fallback has never been tested end to end. Google may block scripted login, so verify both the success path and the Telegram/error handling when login is rejected.
