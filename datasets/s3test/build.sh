#!/bin/bash
# Diagnostics for the builder container's direct R2 (S3) uploads: one verbose PUT, whose curl
# output is saved to R2 (tmp/s3test-debug.txt) through the intercepted route.
echo hello > /tmp/x
{
  echo "R2_AK set: ${R2_AK:+yes} SK len: ${#R2_SK} endpoint: ${R2_ENDPOINT:-none}"
  curl --version | head -1
  curl -sv --max-time 30 --aws-sigv4 "aws:amz:auto:s3" --user "$R2_AK:$R2_SK" -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" -X PUT --data-binary @/tmp/x "$R2_ENDPOINT/pagedb/tmp/s3test-container.txt"
  echo "rc=$?"
  curl -s -o /dev/null -w "head: %{http_code}\n" -I --max-time 30 --aws-sigv4 "aws:amz:auto:s3" --user "$R2_AK:$R2_SK" -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" "$R2_ENDPOINT/pagedb/tmp/s3test-container.txt"
  curl -s -o /dev/null -w "plain https to cloudflare.com: %{http_code}\n" --max-time 15 https://www.cloudflare.com/
} > /tmp/out 2>&1
curl -s -X PUT --data-binary @/tmp/out "http://r2.internal/put/tmp/s3test-debug.txt"
mkdir -p "$OUT"
