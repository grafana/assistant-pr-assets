# Assistant PR assets

`main` owns the Dockerized generator. CI publishes changed SVGs as signed commits
on `assets`, using this repository's built-in `GITHUB_TOKEN`. No custom App or OIDC
broker is needed. Consumers pin the asset commit SHA, never the branch name.

```sh
docker build -t assistant-pr-assets .
mkdir -p /tmp/assistant-pr-assets-output
docker run --rm --network none --shm-size=1g -v /tmp/assistant-pr-assets-output:/output assistant-pr-assets

docker build --target publisher -t assistant-pr-assets-publisher .
docker run --rm -e GITHUB_TOKEN="$(gh auth token)" -v /tmp/assistant-pr-assets-output:/output:ro assistant-pr-assets-publisher
```

Add `--check` to the publisher command to compare without writing. Unchanged SVGs
produce no commit. Published URLs use `https://raw.githubusercontent.com/grafana/assistant-pr-assets/<commit>/open-chat-light.svg`.
