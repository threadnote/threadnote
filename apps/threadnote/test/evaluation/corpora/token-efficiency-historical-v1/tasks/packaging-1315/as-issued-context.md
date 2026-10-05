`str(Marker(...))` can drop the parentheses around a parenthesized sub-group when it is nested inside a larger `and`/`or` expression. The string then reparses with different precedence and can evaluate to the opposite result.

MRE (packaging 26.2):

```python
from packaging.markers import Marker

m = Marker('python_version < "3.10" and ((sys_platform == "linux" or sys_platform == "darwin"))')
env = {"python_version": "3.12", "sys_platform": "darwin"}

print(str(m))
# python_version < "3.10" and sys_platform == "linux" or sys_platform == "darwin"
print(m.evaluate(env))               # False
print(Marker(str(m)).evaluate(env))  # True
```

The original means `A and (B or C)`. The serialized string drops the inner parentheses and reparses as `(A and B) or C`, which flips the result. Expected: `str(Marker(x))` reparses to a marker that evaluates the same as `x` in every environment.
