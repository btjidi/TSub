#!/bin/sh
case " $* " in
  *' -test '*|*' check '*) exit 0 ;;
esac
while :; do sleep 30; done

