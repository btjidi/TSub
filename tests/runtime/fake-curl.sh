#!/bin/sh
set -eu

target=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then
    shift
    target=$1
  fi
  shift
done

[ -n "$target" ]
cp /fake-core "$target"
