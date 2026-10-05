Running a simple client using `h2` with log level DEBUG:

```
DEBUG:hpack.hpack:Adding (b'foo', b'bar') to the header table
DEBUG:hpack.hpack:Encoding 2 with 7 bits
DEBUG:hpack.hpack:Encoding 3 with 7 bits
DEBUG:hpack.hpack:Encoded header block to b'\x83\x87A\x8a\xa0\xe4\x1d\x13\x9d\t\xb8 \xbe\xefD\x8ba\x96$/s\x10\xac\x0ccX_@\x82\x94\xe7\x83\x8cv\x7f'
DEBUG:hpack.hpack:HPACK encoding <generator object _check_path_header.<locals>.inner at 0x7fda203e94a0>
```
The last debug line looks odd.
I'm guessing that data is [probably] sent correctly on the line.
In that case it's only the `hpack` debug that's funky.

Code in question is here: https://github.com/python-hyper/hyper-h2/blob/13005074d14c7d32f8eaf1683b854446a09d09d3/h2/utilities.py#L490-L513 
