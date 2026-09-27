# Credentials and private installation data

Never commit credentials to the public project or to a private installation
repository. Private repositories hold nonsecret configuration and reviewed,
credential-free research notes and source. Use local
secret storage or deployment secrets as described in
[repository setup](docs/REPOSITORIES.md).

Do not include tokens, `.env` files, pairing state, runtime databases, private
keys, camera images, raw captures, or personal inventory in issue reports.
Use synthetic device IDs and addresses in examples and tests. All research is
private, including laboratory notes and experimental helper scripts. Keep it
in the separate installation workspace; raw captures stay out of Git there too.
Public documentation describes supported product behavior, not personal
investigations. Do not copy research files into public documentation or tools.

If a credential entered Git, revoke or rotate it, then assess all affected
branches, tags, clones, pull requests and caches. Deleting the current file is
insufficient. Do not publish sensitive evidence in a public issue.
