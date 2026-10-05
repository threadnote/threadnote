Prompted by https://github.com/encode/httpx/discussions/1735

When a server uses chunked encoding, but erroneously includes whitespace between the `<chunk size marker>` and the `<crlf>`, a `RemoteProtocolError` is raised...

```pycon
>>> import h11
>>> state = h11.Connection(our_role=h11.CLIENT)
>>> state.send(h11.Request(method=b'GET', target='b/', headers=[(b'Host', 'example.com')]))
b'GET b/ HTTP/1.1\r\nHost: example.com\r\n\r\n'
>>> state.send(h11.EndOfMessage())
b''
>>> state.receive_data(b'HTTP/1.1 200 OK\r\n')
>>> state.receive_data(b'Transfer-Encoding: chunked\r\n')
>>> state.receive_data(b'\r\n')
>>> state.receive_data(b'123  \r\n')
>>> state.receive_data(b'x' * 123)
>>> state.receive_data(b'\r\n0\r\n\r\n')
>>> state.next_event()
Response(status_code=200, headers=<Headers([(b'transfer-encoding', b'chunked')])>, http_version=b'1.1', reason=b'OK')
>>> state.next_event()
Traceback (most recent call last):
  File "<stdin>", line 1, in <module>
  File "venv/lib/python3.8/site-packages/h11/_connection.py", line 443, in next_event
    exc._reraise_as_remote_protocol_error()
  File "venv/lib/python3.8/site-packages/h11/_util.py", line 76, in _reraise_as_remote_protocol_error
    raise self
  File "venv/lib/python3.8/site-packages/h11/_connection.py", line 425, in next_event
    event = self._extract_next_receive_event()
  File "/venv/lib/python3.8/site-packages/h11/_connection.py", line 367, in _extract_next_receive_event
    event = self._reader(self._receive_buffer)
  File "venv/lib/python3.8/site-packages/h11/_readers.py", line 157, in __call__
    matches = validate(
  File "venv/lib/python3.8/site-packages/h11/_util.py", line 88, in validate
    raise LocalProtocolError(msg)
h11._util.RemoteProtocolError: illegal chunk header: bytearray(b'123  \r\n')
```

No doubt this is technically correct, but we *probably* want to be robust to this kind of malformed input, given that we've seen it occur as a user-issue in `httpx`.
