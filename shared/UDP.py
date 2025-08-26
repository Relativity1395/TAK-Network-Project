import socket

UDP_PORT = 5005   # change if you like
BUF_SIZE = 4096

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(("0.0.0.0", UDP_PORT))
print(f"[srv] listening on UDP :{UDP_PORT}")

while True:
    data, addr = sock.recvfrom(BUF_SIZE)
    print(f"[rx] {len(data)}B from {addr}: {data!r}")
    # echo back to sender
    sock.sendto(data, addr)