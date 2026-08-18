# Official combined Node.js and Python base image
FROM nikolaik/python-nodejs:python3.11-nodejs20

# Set working directory
WORKDIR /app

# Install Python OCR library
RUN pip install --no-cache-dir ddddocr

# Install Node dependencies
COPY package*.json ./
RUN npm install --production

# Copy application files
COPY . .

# Ensure history directory exists
RUN mkdir -p history

# Port Render will connect to
EXPOSE 3001

# Start the application
CMD ["node", "server.js"]
