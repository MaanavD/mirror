import unittest
import threading
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from camera import Camera, JPEGFrames, MAX_FRAME, handler


class CameraTests(unittest.TestCase):
    def test_split_markers_and_multiple_frames(self):
        parser = JPEGFrames()
        self.assertEqual(parser.feed(b'noise\xff'), [])
        self.assertEqual(parser.feed(b'\xd8abc\xff'), [])
        self.assertEqual(parser.feed(b'\xd9\xff\xd8def\xff\xd9'), [b'\xff\xd8abc\xff\xd9', b'\xff\xd8def\xff\xd9'])

    def test_corrupt_stream_is_bounded_and_recovers(self):
        parser = JPEGFrames()
        parser.feed(b'\xff\xd8' + b'x' * MAX_FRAME)
        self.assertLess(len(parser.buffer), MAX_FRAME)
        self.assertEqual(parser.feed(b'\xff\xd8ok\xff\xd9'), [b'\xff\xd8ok\xff\xd9'])

    def test_old_frame_is_never_returned_as_live(self):
        camera = Camera()
        camera.frame = b'frame'
        camera.updated = 10
        camera.error = None
        with patch('camera.time.monotonic', return_value=11):
            self.assertEqual(camera.snapshot(), (b'frame', None))
        with patch('camera.time.monotonic', return_value=13):
            self.assertEqual(camera.snapshot(), (None, 'Camera signal lost'))

    def test_local_kiosk_reads_frames_and_remote_clients_need_token(self):
        camera = Camera()
        camera.snapshot = lambda: (b'jpeg', None)
        base_handler = handler(camera, 'fixture')
        class RemoteHandler(base_handler):
            def do_GET(self):
                self.client_address = ('100.64.0.2', self.client_address[1])
                super().do_GET()
        for cls, remote in [(base_handler, False), (RemoteHandler, True)]:
            server = ThreadingHTTPServer(('127.0.0.1', 0), cls)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f'http://127.0.0.1:{server.server_port}/api/camera/frame.jpg'
            try:
                if remote:
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(url)
                    self.assertEqual(error.exception.code, 401)
                else:
                    with urllib.request.urlopen(url) as response:
                        self.assertEqual(response.read(), b'jpeg')
                req = urllib.request.Request(url, headers={'Authorization': 'Bearer fixture'})
                with urllib.request.urlopen(req) as response:
                    self.assertEqual(response.read(), b'jpeg')
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
