import { NextRequest, NextResponse } from 'next/server';
import { dbOps, parseDurationToSeconds } from '@/lib/db';
import { dbUtils } from '@/lib/db-utils';
import { v4 as uuidv4 } from 'uuid';
import https from 'https';
import http from 'http';

// Add type for fetch options
type FetchOptions = {
  agent?: https.Agent;
};

// Type definitions for API responses
interface SystemInfoOption {
  Name: string;
  DefaultValue: string;
}

interface SystemInfo {
  MachineName: string;
  Options?: SystemInfoOption[];
}

interface BackupInfo {
  Backup: {
    ID: string;
    Name: string;
  };
}

interface LogEntry {
  Message: string;
}

// Helper function to make HTTP/HTTPS requests
async function makeRequest(url: string, options: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsedData = JSON.parse(data);
          const statusCode = res.statusCode ?? 500;
          resolve({
            ok: statusCode >= 200 && statusCode < 300,
            status: statusCode,
            statusText: res.statusMessage ?? 'Unknown status',
            json: async () => parsedData
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

export async function POST(request: NextRequest) {
  try {
    const { 
      hostname, 
      port = 8200, 
      password, 
      protocol = 'http',
      allowSelfSigned = false
    } = await request.json();

    if (!hostname) {
      return NextResponse.json(
        { error: 'Hostname is required' },
        { status: 400 }
      );
    }

    if (!password) {
      return NextResponse.json(
        { error: 'Password is required' },
        { status: 400 }
      );
    }

    // Validate protocol
    if (protocol !== 'http' && protocol !== 'https') {
      return NextResponse.json(
        { error: 'Protocol must be either "http" or "https"' },
        { status: 400 }
      );
    }

    const baseUrl = `${protocol}://${hostname}:${port}`;
    const loginEndpoint = '/api/v1/auth/login';
    const apiSysteminfoEndpoint = '/api/v1/systeminfo';
    const apiBackupsEndpoint = '/api/v1/backups';
    const apiLogBaseEndpoint = '/api/v1/backup';

    // Create request options
    const requestOptions = {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      ...(protocol === 'https' && {
        agent: new https.Agent({
          rejectUnauthorized: !allowSelfSigned
        })
      })
    };

    // Step 1: Login and get token
    const loginResponse = await makeRequest(`${baseUrl}${loginEndpoint}`, {
      ...requestOptions,
      method: 'POST',
      body: JSON.stringify({
        Password: password,
        RememberMe: true
      })
    });

    if (!loginResponse.ok) {
      throw new Error(`Login failed: ${loginResponse.statusText}`);
    }

    const loginData = await loginResponse.json();
    const authToken = loginData.AccessToken;

    if (!authToken) {
      throw new Error('No authentication token received');
    }

    // Step 2: Get system info
    const systemInfoResponse = await makeRequest(`${baseUrl}${apiSysteminfoEndpoint}`, {
      ...requestOptions,
      headers: {
        ...requestOptions.headers,
        'Authorization': `Bearer ${authToken}`
      }
    });

    if (!systemInfoResponse.ok) {
      throw new Error(`Failed to get system info: ${systemInfoResponse.statusText}`);
    }

    const systemInfo: SystemInfo = await systemInfoResponse.json();
    const machineId = systemInfo.Options?.find((opt) => opt.Name === 'machine-id')?.DefaultValue;
    const machineName = systemInfo.MachineName;

    if (!machineId || !machineName) {
      throw new Error('Could not get machine information');
    }
    
    // Upsert machine information in the database
    dbOps.upsertMachine.run({
        id: machineId,
        name: machineName
      });
  
    // Step 3: Get list of backups
    const backupsResponse = await makeRequest(`${baseUrl}${apiBackupsEndpoint}`, {
      ...requestOptions,
      headers: {
        ...requestOptions.headers,
        'Authorization': `Bearer ${authToken}`
      }
    });

    if (!backupsResponse.ok) {
      throw new Error(`Failed to get backups list: ${backupsResponse.statusText}`);
    }

    const backups: BackupInfo[] = await backupsResponse.json();
    const backupIds = backups.map((b) => b.Backup.ID);

    if (!backupIds.length) {
      return NextResponse.json({ message: 'No backups found' });
    }

    // Step 4: Process each backup
    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const backupId of backupIds) {
      try {
        const logEndpoint = `${apiLogBaseEndpoint}/${backupId}/log?pagesize=999`;
        const logResponse = await makeRequest(`${baseUrl}${logEndpoint}`, {
          ...requestOptions,
          headers: {
            ...requestOptions.headers,
            'Authorization': `Bearer ${authToken}`
          }
        });

        if (!logResponse.ok) {
          throw new Error(`Failed to get logs for backup ${backupId}: ${logResponse.statusText}`);
        }

        const logs: LogEntry[] = await logResponse.json();
        const backupMessages = logs.filter((log) => {
          try {
            // Parse the Message string into JSON
            const messageObj = JSON.parse(log.Message);
            // Add debug logging to understand the data structure
            console.log('Parsed log entry:', JSON.stringify(messageObj, null, 2));
            return messageObj?.MainOperation === 'Backup';
          } catch (error) {
            console.error('Error parsing log message:', error);
            return false;
          }
        });

        for (const log of backupMessages) {
          // Parse the message string into JSON for each log entry
          const message = JSON.parse(log.Message);
          const backupDate = new Date(message.BeginTime).toISOString();

          // Check for duplicate
          const backupName = backups.find((b) => b.Backup.ID === backupId)?.Backup.Name;
          if (!backupName) continue;
          
          const isDuplicate = await dbUtils.checkDuplicateBackup({
            machine_id: machineId,
            backup_name: backupName,
            date: backupDate
          });

          if (isDuplicate) {
            skippedCount++;
            continue;
          }

          // Map backup status
          let status = message.ParsedResult;
          if (status === "Success" && message.WarningsActualLength > 0) {
            status = "Warning";
          }

          // Insert backup data
          dbOps.insertBackup.run({
            id: uuidv4(),
            machine_id: machineId,
            backup_name: backupName,
            backup_id: backupId,
            date: backupDate,
            status: status,
            duration_seconds: parseDurationToSeconds(message.Duration),
            size: message.SizeOfExaminedFiles || 0,
            uploaded_size: message.BackendStatistics?.BytesUploaded || 0,
            examined_files: message.ExaminedFiles || 0,
            warnings: message.WarningsActualLength || 0,
            errors: message.ErrorsActualLength || 0,

            // Message arrays stored as JSON blobs
            messages_array: message.Messages ? JSON.stringify(message.Messages) : null,
            warnings_array: message.Warnings ? JSON.stringify(message.Warnings) : null,
            errors_array: message.Errors ? JSON.stringify(message.Errors) : null,

            // Data fields
            deleted_files: message.DeletedFiles || 0,
            deleted_folders: message.DeletedFolders || 0,
            modified_files: message.ModifiedFiles || 0,
            opened_files: message.OpenedFiles || 0,
            added_files: message.AddedFiles || 0,
            size_of_modified_files: message.SizeOfModifiedFiles || 0,
            size_of_added_files: message.SizeOfAddedFiles || 0,
            size_of_examined_files: message.SizeOfExaminedFiles || 0,
            size_of_opened_files: message.SizeOfOpenedFiles || 0,
            not_processed_files: message.NotProcessedFiles || 0,
            added_folders: message.AddedFolders || 0,
            too_large_files: message.TooLargeFiles || 0,
            files_with_error: message.FilesWithError || 0,
            modified_folders: message.ModifiedFolders || 0,
            modified_symlinks: message.ModifiedSymlinks || 0,
            added_symlinks: message.AddedSymlinks || 0,
            deleted_symlinks: message.DeletedSymlinks || 0,
            partial_backup: message.PartialBackup ? 1 : 0,
            dryrun: message.Dryrun ? 1 : 0,
            main_operation: message.MainOperation,
            parsed_result: message.ParsedResult,
            interrupted: message.Interrupted ? 1 : 0,
            version: message.Version,
            begin_time: new Date(message.BeginTime).toISOString(),
            end_time: new Date(message.EndTime).toISOString(),
            warnings_actual_length: message.WarningsActualLength || 0,
            errors_actual_length: message.ErrorsActualLength || 0,
            messages_actual_length: message.MessagesActualLength || 0,

            // BackendStatistics fields
            bytes_downloaded: message.BackendStatistics?.BytesDownloaded || 0,
            known_file_size: message.BackendStatistics?.KnownFileSize || 0,
            last_backup_date: message.BackendStatistics?.LastBackupDate ? new Date(message.BackendStatistics.LastBackupDate).toISOString() : null,
            backup_list_count: message.BackendStatistics?.BackupListCount || 0,
            reported_quota_error: message.BackendStatistics?.ReportedQuotaError ? 1 : 0,
            reported_quota_warning: message.BackendStatistics?.ReportedQuotaWarning ? 1 : 0,
            backend_main_operation: message.BackendStatistics?.MainOperation,
            backend_parsed_result: message.BackendStatistics?.ParsedResult,
            backend_interrupted: message.BackendStatistics?.Interrupted ? 1 : 0,
            backend_version: message.BackendStatistics?.Version,
            backend_begin_time: message.BackendStatistics?.BeginTime ? new Date(message.BackendStatistics.BeginTime).toISOString() : null,
            backend_duration: message.BackendStatistics?.Duration,
            backend_warnings_actual_length: message.BackendStatistics?.WarningsActualLength || 0,
            backend_errors_actual_length: message.BackendStatistics?.ErrorsActualLength || 0
          });

          processedCount++;
        }
      } catch (error) {
        console.error(`Error processing backup ${backupId}:`, error);
        errorCount++;
      }
    }

    return NextResponse.json({
      success: true,
      stats: {
        processed: processedCount,
        skipped: skippedCount,
        errors: errorCount
      }
    });

  } catch (error) {
    console.error('Error collecting backups:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to collect backups' },
      { status: 500 }
    );
  }
} 