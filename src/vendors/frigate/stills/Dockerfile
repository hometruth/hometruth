FROM python:3.11-slim-bookworm
ENV PYTHONUNBUFFERED=1 OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 \
    YOLO_CONFIG_DIR=/tmp/yolo MPLCONFIGDIR=/tmp/matplotlib
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir speciesnet==5.0.5 'numpy<2'
WORKDIR /app
COPY download_model.py worker.py request.py ./
RUN python download_model.py && pip freeze > /app/requirements.lock
USER 65534:65534
CMD ["python", "/app/worker.py"]
