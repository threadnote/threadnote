"""Portable process-scoped advisory locks for local workflow receipts.

Lock files are persistent: unlinking them would let concurrent writers lock different
inodes. Both backends lock the same first byte and release ownership on close.
"""
import errno
import os
import time


def lock_exclusive(stream, blocking=True):
    """Acquire ownership until the stream closes; nonblocking contention raises."""
    if os.name != "nt":
        import fcntl
        fcntl.flock(stream, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        return
    import msvcrt
    # msvcrt locks a byte range, including beyond EOF. Never truncate a lock file.
    while True:
        stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            return
        except OSError as error:
            if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise
            if not blocking:
                raise BlockingIOError(error.errno, "Workflow lock is owned") from error
            time.sleep(0.05)
