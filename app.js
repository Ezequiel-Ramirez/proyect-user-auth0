import express from 'express';
import multer from 'multer';
import mysql from 'mysql';
import csv from 'csv-parser';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import pLimit from 'p-limit';
import moment from 'moment';


// Cargar variables de entorno desde el archivo .env
dotenv.config();
const app = express();
const port = process.env.PORT ?? 3000;

// Configuración de almacenamiento para Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

// Crear carpeta de uploads si no existe
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Configuración de la base de datos MySQL
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
});

// Conectar a la base de datos MySQL
db.connect((err) => {
    if (err) {
        console.error('Error connecting to the database:', err);
        return;
    }
    console.log('Connected to the MySQL database.');
});

// Configuración de Auth0
const auth0Domain = process.env.AUTH0_DOMAIN;
const auth0ClientId = process.env.AUTH0_CLIENT_ID;
const auth0ClientSecret = process.env.AUTH0_CLIENT_SECRET;
const auth0Audience = process.env.AUTH0_AUDIENCE;

/* ################################### FUNCTIONS ####################################### */
// Obtener token de acceso de Auth0
async function getAuth0Token() {
    try {
        const response = await axios.post(`https://${auth0Domain}/oauth/token`, {
            client_id: auth0ClientId,
            client_secret: auth0ClientSecret,
            audience: auth0Audience,
            grant_type: 'client_credentials'
        });
        console.log('Auth0 token:', response.data.access_token);
        return response.data.access_token;
    } catch (error) {
        console.error('Error getting Auth0 token:', error);
    }
}

// Función para eliminar un usuario en Auth0
async function deleteUserInAuth0(userId, token) {
    try {
        const response = await axios.delete(`https://${auth0Domain}/api/v2/users/${userId}`, {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });
        console.log(`Usuario ${userId} eliminado exitosamente en Auth0`);
        return response.status;
    } catch (error) {
        const errorMessage = error.response
            ? `${error.response.status} - ${error.response.data.error}: ${error.response.data.error_description}`
            : error.message;
        
        console.error(`Error eliminando el usuario ${userId} en Auth0: ${errorMessage}`);
        throw new Error(`Error eliminando el usuario ${userId}: ${errorMessage}`);
    }
}


// Buscar usuario en Auth0 por email
async function getAuth0UserByEmail(token, email) {
    try {
        const response = await axios.get(`https://${auth0Domain}/api/v2/users-by-email`, {
            headers: {
                Authorization: `Bearer ${token}`
            },
            params: {
                email: email
            }
        });
        console.log('Auth0 user by email:', response.data[0]);
        return response.data[0]; // Retorna el primer usuario encontrado
    } catch (error) {
        console.error('Error getting Auth0 user by email:', error);
    }
}

// Buscar usuario en Auth0 por DNI u otro dato en los metadatos
async function getAuth0UserByDNI(token, dni) {
    try {
        const response = await axios.get(`https://${auth0Domain}/api/v2/users`, {
            headers: {
                Authorization: `Bearer ${token}`
            },
            params: {
                q: `user_metadata.taxvat:"${dni}"`, // Reemplaza "dni" con el nombre real que uses en los metadatos
                search_engine: 'v3' // Uso del motor de búsqueda correcto
            }
        });

        console.log('Auth0 user by DNI:', response.data[0]);
        return response.data; // Retorna el primer usuario encontrado por DNI
    } catch (error) {
        console.error('Error getting Auth0 user by DNI:', error);
    }
}

// Función para obtener el género en el formato esperado
function getGender(genderCode) {
    switch (genderCode) {
        case 1:
        case '1':
        case 'masc':
        case 'masculino':
        case 'Masculino':
        case 'MASCULINO':
            return 'Masculino';
        case 2:
        case '2':
        case 'fem':
        case 'femenino':
        case 'Femenino':
        case 'FEMENINO':
            return 'Femenino';
        default:
            return 'Masculino';
    }
}

//Funcion para obtener todos los registros de la tabla user por su email unico en la tabla de user
async function getAllUsersByUniqueEmailAndStatusActive() {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT * FROM (
                SELECT *,
                       ROW_NUMBER() OVER (PARTITION BY email 
                                          ORDER BY CASE 
                                              WHEN q_susc_activas > 0 THEN 1 
                                              ELSE 2 
                                          END, 
                                          created_on DESC) as rn
                FROM user
            ) as ranked_users
            WHERE rn = 1
        `;
        //query donde incluya tambien los usuarios que no tengan suscripciones activas o sea q_susc_activas = 0
        // const query = `
        //     SELECT * FROM (
        //         SELECT *,
        //                ROW_NUMBER() OVER (PARTITION BY email
        //                                   ORDER BY CASE
        //                                       WHEN q_susc_activas > 0 THEN 1
        //                                       ELSE 2
        //                                   END,
        //                                   created_on DESC) as rn
        //         FROM user
        //     ) as ranked_users
        //     WHERE rn = 1
        // `;
        db.query(query, (err, results) => {
            if (err) {
                console.error('Error fetching data from user table:', err);
                reject(err);
            } else {
                resolve(results);
            }
        });
    }
    );
}

//Funcion para obtener todos los registros de la tabla user por su dni unico en la tabla de user y que tengan suscripciones activas en la tabla de user o sin suscripciones activas (q_susc_activas = 0)
async function getAllUsersByUniqueDniAndStatusActiveOrInactive() {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT * FROM (
                SELECT *,
                       ROW_NUMBER() OVER (PARTITION BY email
                                          ORDER BY CASE 
                                              WHEN q_susc_activas > 0 THEN 1 
                                              ELSE 2 
                                          END, 
                                          created_on DESC) as rn
                FROM user
            ) as ranked_users
            WHERE rn = 1 AND q_susc_activas >= 0
        `;
        db.query(query, (err, results) => {
            if (err) {
                console.error('Error fetching data from user table:', err);
                reject(err);
            } else {
                resolve(results);
            }
        });
    });
}

// Función para encontrar un usuario en la tabla auth0_user por email
async function findMatchingAuth0User(email) {
    return new Promise((resolve, reject) => {
        const query = 'SELECT * FROM auth0_user WHERE Email = ?';
        const values = [email];
        db.query(query, values, (err, results) => {
            if (err) {
                console.error('Error finding matching user in auth0_user table:', err);
                reject(err);
            } else {
                if (results.length > 0) {
                    resolve(results[0]); // Retorna el primer usuario encontrado
                } else {
                    resolve(null); // Retorna null si no se encuentra ningún usuario
                }
            }
        });
    });
}

// Función para encontrar un usuario en la tabla auth0_user por DNI y que no lo haya encontrado por email
async function findMatchingAuth0UserByDni(email, dni) {
    return new Promise((resolve, reject) => {
        // Primer intento: buscar por email
        const queryByEmail = 'SELECT * FROM auth0_user WHERE LOWER(Email) = LOWER(?)';
        db.query(queryByEmail, [email], (err, resultsByEmail) => {
            if (err) {
                console.error('Error finding matching user by email in auth0_user table:', err);
                return reject(err);
            }

            // if (resultsByEmail.length > 0) {
            //     // Usuario encontrado por email, no continuamos con la búsqueda por DNI
            //     return resolve(null);
            // }

            // Si no se encuentra por email, intentar buscar por DNI
            const queryByDNI = 'SELECT * FROM auth0_user WHERE taxvat = ?';
            db.query(queryByDNI, [dni], (err, resultsByDNI) => {
                if (err) {
                    console.error('Error finding matching user by DNI in auth0_user table:', err);
                    return reject(err);
                }

                if (resultsByDNI.length > 0) {
                    return resolve(resultsByDNI[0]); // Usuario encontrado por DNI
                } else {
                    return resolve(null); // No se encontró ningún usuario
                }
            });
        });
    });
}

// Función para actualizar el metadata del usuario en Auth0
async function updateAuth0UserMetadata(token, userId, codArea, telephone2) {
    try {
        await axios.patch(`https://${auth0Domain}/api/v2/users/${userId}`, {
            // user_metadata: {
            //     crm_id: crmId,
            //     first_name: firstName,
            //     last_name: lastName,
            //     birthday: birthDate,
            //     taxvat: axxNrodocumento,
            //     active_subs: suscActivas
            // }
            //solo actualizar active_subs en el metadata y no los demas campos
            user_metadata: {
                // active_subs: suscActivas
                telephone_area: codArea,
                telephone_number: telephone2
            }
            
        }, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });
    } catch (error) {
        console.error(`Error updating user metadata for Auth0 user ${userId}:`, error);
    }
}
// Función para actualizar el metadata del usuario en Auth0 solo genero
async function updateAuth0UserMetadataGender(token, userId, gender) {
    try {
        await axios.patch(`https://${auth0Domain}/api/v2/users/${userId}`, {
            user_metadata: {
                gender: gender,
            }
        }, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });
    } catch (error) {
        console.error(`Error updating user metadata for Auth0 user in Gender ${userId}:`, error);
    }
}

// Función para actualizar el metadata del usuario en Auth0 solo fecha de nacimiento
async function updateAuth0UserMetadataBirthday(token, userId, birthDate) {
    try {
        await axios.patch(`https://${auth0Domain}/api/v2/users/${userId}`, {
            user_metadata: {
                birthday: birthDate,
            }
        }, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });
    } catch (error) {
        console.error(`Error updating user metadata for Auth0 user in Birthday ${userId}:`, error);
    }
}

// Función para determinar si la fecha de cumpleaños debe ser convertida
function shouldConvertBirthday(birthday) {
    // Verificar si el cumpleaños está en uno de los formatos especificados 
    // (DD-MM-YY, DD/MM/YY, DD.MM.YY, DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY o "YYYY-MM-DD 02:00:00.000")
    const dateFormatsRegex = /^\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}$/;
    const fullDateTimeRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;

    // Verificar si cumple con alguno de los dos formatos
    const isBirthdayValid = dateFormatsRegex.test(birthday) || fullDateTimeRegex.test(birthday);

    console.log('Birthday test:', isBirthdayValid);
    return isBirthdayValid;
}


// Función para convertir la fecha al formato 'YYYY-MM-DD 02:00:00.000'
function convertBirthday(birthday) {
    let parsedDate;

    // Detectar el formato de la fecha y convertirla a 'YYYY-MM-DDTHH:mm:ss'
    if (/^\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2}$/.test(birthday)) {
        // Caso de fechas como '01-01-01' o '01/01/00'
        parsedDate = moment(birthday, ['DD-MM-YY', 'DD/MM/YY', 'DD.MM.YY']);
    } else if (/^\d{1,2}[-\/.]\d{1,2}[-\/.]\d{4}$/.test(birthday)) {
        // Caso de fechas como '01-03-1988', '01/01/1956', '01.04.1949'
        parsedDate = moment(birthday, ['DD-MM-YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY']);
    } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(birthday)) {
        // Caso de fechas como '1986-11-27 02:00:00.000'
        parsedDate = moment(birthday, 'YYYY-MM-DD HH:mm:ss.SSS');
    }

    if (parsedDate && parsedDate.isValid()) {
        // Formatear la fecha a 'YYYY-MM-DDTHH:mm:ss'
        return parsedDate.format('YYYY-MM-DDTHH:mm:ss');
    }

    // Si la fecha no es válida, devolver null
    return null;
}



/* ################################### ROUTES ####################################### */
// Ruta para crear la tabla `user` en MySQL
app.get('/users/create-table-users', (req, res) => {
    const query = `
        CREATE TABLE IF NOT EXISTS user (
            id INT AUTO_INCREMENT PRIMARY KEY,
            created_on VARCHAR(255),
            contact_id VARCHAR(255),
            email VARCHAR(255),
            first_name VARCHAR(100),
            last_name VARCHAR(100),
            gender_code VARCHAR(10),
            axx_genero INT,
            birth_date VARCHAR(255),
            axx_tipodocumento VARCHAR(50),
            axx_nrodocumento VARCHAR(50),
            q_susc_activas VARCHAR(50),
            axx_ani VARCHAR(50),
            axx_codigodearea VARCHAR(50),
            Telephone2 VARCHAR(50)
        )
    `;

    db.query(query, (err, result) => {
        if (err) {
            console.error('Error creating table:', err);
            return res.status(500).send('Error creating table.');
        }
        console.log('Table `user` created or already exists.');
        res.send('Table `user` created or already exists.');
    });
});

// Ruta para crear la tabla `user_filtered` en MySQL
app.get('/users/create-table-users-filtered', (req, res) => {
    const query = `
        CREATE TABLE IF NOT EXISTS user_filtered (
            id INT AUTO_INCREMENT PRIMARY KEY,
            created_on VARCHAR(255),
            contact_id VARCHAR(255),
            email VARCHAR(255),
            first_name VARCHAR(100),
            last_name VARCHAR(100),
            gender_code VARCHAR(10),
            axx_genero INT,
            birth_date VARCHAR(255),
            axx_tipodocumento VARCHAR(50),
            axx_nrodocumento VARCHAR(50),
            q_susc_activas VARCHAR(50),
            axx_ani VARCHAR(50),
            axx_codigodearea VARCHAR(50),
            Telephone2 VARCHAR(50)
        )
    `;

    db.query(query, (err, result) => {
        if (err) {
            console.error('Error creating table:', err);
            return res.status(500).send('Error creating table.');
        }
        console.log('Table `user_filtered` created or already exists.');
        res.send('Table `user_filtered` created or already exists.');
    });
});

//Ruta para crear la tabla de usuarios Auth0 en MySQL
app.get('/users/create-table-auth0-users', (req, res) => {
    const query = `
        CREATE TABLE IF NOT EXISTS auth0_user (
            first_name VARCHAR(255),
            last_name VARCHAR(255),
            gender VARCHAR(255),
            birthday VARCHAR(255),
            taxvat VARCHAR(255),
            taxvat_type VARCHAR(255),
            crm_id VARCHAR(255),
            Id VARCHAR(255) PRIMARY KEY,
            Given_Name VARCHAR(255),
            Family_Name VARCHAR(255),
            Nickname VARCHAR(255),
            Name VARCHAR(255),
            Email VARCHAR(255),
            Email_Verified BOOLEAN,
            Created_At DATETIME,
            Updated_At DATETIME,
            last_login DATETIME
        )
    `;
    db.query(query, (err, result) => {
        if (err) {
            console.error('Error creating table:', err);
            return res.status(500).send('Error creating table.');
        }
        console.log('Table `auth0_user` created or already exists.');
        res.send('Table `auth0_user` created or already exists.');
    }
    );
});

// Ruta para subir el archivo CSV a la tabla auth0_user en MySQL
app.post('/users/upload-file-auth0', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    const filePath = req.file.path;
    const results = [];

    fs.createReadStream(filePath)
        .pipe(csv({ separator: ',' }))
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            for (const row of results) {
                // Remover comillas simples de los valores
                Object.keys(row).forEach(key => {
                    row[key] = row[key].replace(/^'+|'+$/g, '');
                });

                const {
                    first_name,
                    last_name,
                    gender,
                    birthday,
                    taxvat,
                    taxvat_type,
                    crm_id,
                    Id,
                    'Given Name': Given_Name,
                    'Family Name': Family_Name,
                    Nickname,
                    Name,
                    Email,
                    'Email Verified': Email_Verified,
                    'Created At': Created_At,
                    'Updated At': Updated_At,
                    'Last Login': last_login
                } = row;

                // Validar que los campos necesarios no sean nulos
                if (!Id || !Email) {
                    console.error('Missing required data: Id or Email is null');
                    continue; // Saltar esta fila si falta datos necesarios
                }


                const query = `INSERT INTO auth0_user (
                    first_name, last_name, gender, birthday, taxvat, taxvat_type, crm_id, Id, Given_Name, Family_Name, Nickname, Name, Email, Email_Verified, Created_At, Updated_At, last_login
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

                db.query(query, [
                    first_name || null,
                    last_name || null,
                    gender || null,
                    birthday || null,
                    taxvat || null,
                    taxvat_type || null,
                    crm_id || null,
                    Id,
                    Given_Name || null,
                    Family_Name || null,
                    Nickname || null,
                    Name || null,
                    Email,
                    Email_Verified === 'true', // Convertir a booleano
                    Created_At ? new Date(Created_At) : null,
                    Updated_At ? new Date(Updated_At) : null,
                    last_login ? new Date(last_login) : null
                ], (err, results) => {
                    if (err) {
                        console.error('Error inserting data:', err);
                    } else {
                        console.log('Data inserted successfully for Id:', Id);
                    }
                });
            }

            fs.unlinkSync(filePath); // Elimina el archivo después de procesarlo
            res.send('Archivo CSV subido y datos insertados en la base de datos "auth0_user".');
        });
});

// Ruta para subir el archivo CSV a la tabla user de MySQL
app.post('/users/upload-file', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }

    const filePath = req.file.path;
    const results = [];

    fs.createReadStream(filePath)
        .pipe(csv({ separator: ';' }))
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            for (const row of results) {
                const {
                    CreatedOn,
                    ContactId,
                    EMailAddress1,
                    FirstName,
                    LastName,
                    GenderCode,
                    axx_genero,
                    BirthDate,
                    axx_tipodocumento,
                    axx_nrodocumento,
                    'Q susc activas': q_susc_activas,
                    axx_ani,
                    axx_codigodearea,
                    Telephone2
                } = row;

                const query = 'INSERT INTO user (created_on, contact_id, email, first_name, last_name, gender_code, axx_genero, birth_date, axx_tipodocumento, axx_nrodocumento, q_susc_activas, axx_ani, axx_codigodearea, telephone2) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

                db.query(query, [
                    CreatedOn || null,
                    ContactId || null,
                    EMailAddress1 || null,
                    FirstName || null,
                    LastName || null,
                    GenderCode || null,
                    axx_genero || null,
                    BirthDate || null,
                    axx_tipodocumento || null,
                    axx_nrodocumento || null,
                    q_susc_activas || null,
                    axx_ani || null,
                    axx_codigodearea || null,
                    Telephone2 || null
                ], (err, results) => {
                    if (err) {
                        console.error('Error inserting data:', err);
                    } else {
                        console.log('Data inserted successfully for ContactId:', ContactId, CreatedOn);
                    }
                });
            }

            fs.unlinkSync(filePath); // Elimina el archivo después de procesarlo
            res.send('Archivo CSV subido y datos insertados en la base de datos "user".');
        });
});

// Ruta para leer datos de MySQL
app.get('/users', (req, res) => {
    const query = 'SELECT * FROM user';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error reading data from MySQL:', err);
            return res.status(500).send('Error reading data from MySQL.');
        }
        res.json(results); // Retorna los datos de usuarios
    });
});

// Ruta para buscar usuario en Auth0 por email
app.get('/users/auth0-search', async (req, res) => {
    const email = req.query.email;
    if (!email) {
        return res.status(400).send('Email is required.');
    }

    try {
        // Obtener token de acceso de Auth0
        const token = await getAuth0Token();

        // Buscar usuario en Auth0 por email
        const auth0User = await getAuth0UserByEmail(token, email);

        if (auth0User) {
            res.json(auth0User); // Retorna el usuario de Auth0
        } else {
            res.status(404).send('User not found in Auth0.');
        }
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).send('Error processing request.');
    }
});

//Ruta para buscar usuario en MySQL por email o dni
app.get('/users/search', (req, res) => {
    const email = req.query.email;
    const dni = req.query.dni;

    if (!email && !dni) {
        return res.status(400).send('Email or DNI is required.');
    }

    let query = 'SELECT * FROM user WHERE 1=1';
    const values = [];

    if (email) {
        query += ' AND email = ?';
        values.push(email);
    }

    if (dni) {
        query += ' AND axx_nrodocumento = ?';
        values.push(dni);
    }

    db.query(query, values, (err, results) => {
        if (err) {
            console.error('Error reading data from MySQL:', err);
            return res.status(500).send('Error reading data from MySQL.');
        }

        if (results.length > 0) {
            res.json(results); // Retorna los datos de usuarios
        } else {
            res.status(404).send('User not found in MySQL.');
        }
    });
});

// Ruta para filtrar y encontrar usuarios en MySQL y Auth0 ya sea por email o DNI y volcarlos en la tabla user_filtered o user_filtered_bydni
app.get('/users/filter-and-find', async (req, res) => {
    try {
        const users = await getAllUsersByUniqueDniAndStatusActiveOrInactive();
        const filteredResults = [];

        for (const user of users) {
            console.log('User:', user);
            const { email, axx_nrodocumento } = user;
            const auth0User = await findMatchingAuth0User(email?.toLowerCase()) // Buscar por email y guardar en tabla user_filtered
            // const auth0User = await findMatchingAuth0UserByDni(email?.toLowerCase(), axx_nrodocumento); // Buscar por DNI y guardar en tabla user_filtered_bydni
            if (auth0User) {
                filteredResults.push(user);
            }
        }

        // Guardar en tabla user_filtered y manejar logs
        const logSuccess = [];
        const logError = [];
        console.log('Filtered results:', filteredResults);
        

        console.log(`Total filtered users: ${filteredResults.length}`);
        for (const user of filteredResults) {
            const { created_on, contact_id, email, first_name, last_name, gender_code, axx_genero, birth_date, axx_tipodocumento, axx_nrodocumento, q_susc_activas, axx_ani, axx_codigodearea, Telephone2 } = user;
            const query = 'INSERT INTO user_filtered (created_on, contact_id, email, first_name, last_name, gender_code, axx_genero, birth_date, axx_tipodocumento, axx_nrodocumento, q_susc_activas, axx_ani, axx_codigodearea, Telephone2) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
            // const query = 'INSERT INTO user_filtered_bydni (created_on, contact_id, email, first_name, last_name, gender_code, axx_genero, birth_date, axx_tipodocumento, axx_nrodocumento, q_susc_activas, axx_ani, axx_codigodearea, Telephone2) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

            try {
                await new Promise((resolve, reject) => {
                    db.query(query, [
                        created_on || null,
                        contact_id || null,
                        email || null,
                        first_name || null,
                        last_name || null,
                        gender_code || null,
                        axx_genero || null,
                        birth_date || null,
                        axx_tipodocumento || null,
                        axx_nrodocumento || null,
                        q_susc_activas || 0,
                        axx_ani || null,
                        axx_codigodearea || null,
                        Telephone2 || null
                    ], (err, results) => {
                        if (err) {
                            logError.push(`Error inserting data: ${email} with ContactId: ${contact_id} and DNI: ${axx_nrodocumento}`);
                            return reject(err);
                        } else {
                            logSuccess.push(`User filtered: ${email} with ContactId: ${contact_id} and DNI: ${axx_nrodocumento}`);
                            return resolve(results);
                        }
                    });
                });
            } catch (err) {
                console.error('Error inserting data:', err);
            }
        }

        // Escribir logs en archivos al final
        if (logError.length) {
            // fs.appendFile('logsErrorUserFilteredByDNI.txt', logError.join('\n') + '\n', (err) => {
            fs.appendFile('logsErrorUserFiltered.txt', logError.join('\n') + '\n', (err) => {
                if (err) console.error('Error writing logs:', err);
            });
        }

        if (logSuccess.length) {
            // fs.appendFile('logsSuccesUserFilteredByDNI.txt', logSuccess.join('\n') + '\n', (err) => {
            fs.appendFile('logsSuccesUserFiltered.txt', logSuccess.join('\n') + '\n', (err) => {
                if (err) console.error('Error writing logs:', err);
            });
        }

        // Contar éxitos y errores
        const successCount = logSuccess.length;
        const errorCount = logError.length;

        // Agregar conteo al final de los logs
        // fs.appendFile('logsSummaryUserFilteredByDNI.txt', `Total successful inserts: ${successCount}\nTotal errors: ${errorCount}\n`, (err) => {
        fs.appendFile('logsSummaryUserFiltered.txt', `Total successful inserts: ${successCount}\nTotal errors: ${errorCount}\n`, (err) => {
            if (err) {
                console.error('Error writing summary logs:', err);
            }
        });

        res.json(filteredResults); // Retorna los resultados filtrados
    } catch (error) {
        console.error('Error filtering and finding data:', error);
        res.status(500).send('Error filtering and finding data.');
    }
});



// Límite de solicitudes concurrentes
const limit = pLimit(5); // Ajusta este valor según tus necesidades y límites de Auth0
let count = 0;

// Ruta para leer datos de MySQL y buscar en Auth0 para actualizar metadata
app.get('/users/update-metadata', async (req, res) => {
    const limitParam = parseInt(req.query.limit, 10) || 100;
    const offset = parseInt(req.query.offset, 10) || 0;

    let count = 0;
    const logSuccess = [];
    const logError = [];

    try {
        const query = 'SELECT * FROM user_filtered LIMIT ? OFFSET ?';
        db.query(query, [limitParam, offset], async (err, results) => {
            if (err) {
                console.error('Error reading data from MySQL:', err);
                return res.status(500).send('Error reading data from MySQL.');
            }

            try {
                const token = await getAuth0Token();
                let auth0User;
                const usersPromises = results.map((row) => limit(async () => {
                    const email = row.email;
                    // const crmId = row.contact_id;
                    // const firstName = row.first_name;
                    // const lastName = row.last_name;
                    // const birthDate = row.birth_date;
                    const axxNrodocumento = row.axx_nrodocumento;
                    // const suscActivas = row.q_susc_activas;
                    const codArea = row.axx_codigodearea;
                    const telephone2 = row.Telephone2;
                    // Intentar primero buscar por email
                    let auth0User = await getAuth0UserByEmail(token, email?.toLowerCase());

                    // Si no encuentra por email, buscar por DNI
                    if (!auth0User) {
                    console.log(`No user found with email: ${email}. Trying with DNI: ${axxNrodocumento}`);
                    auth0User = await getAuth0UserByDNI(token, axxNrodocumento);
                    }
                    console.log ('Auth0 user by email updated:', auth0User);
                    // console.log('Auth0 user by dni updated:', auth0User[0].user_id);
                    if (auth0User) {
                        await updateAuth0UserMetadata(
                            token,
                            auth0User.user_id,
                            // crmId,
                            // firstName,
                            // lastName,
                            // birthDate,
                            // axxNrodocumento,
                            // suscActivas
                            codArea,
                            telephone2
                        );
                        count++;
                        logSuccess.push(`User metadata updated for Auth0 user by EMAIL OR DNI: ${auth0User.user_id} (${count})`);
                        console.log(`User metadata updated for Auth0 user: ${auth0User.user_id} (${count})`);
                    }

                    return { email, auth0User };
                }));

                const users = await Promise.all(usersPromises);

                // Escribir logs de éxito al final
                if (logSuccess.length) {
                    fs.appendFile('logsSuccessUpdateMetadataByEMAILORDNI.txt', logSuccess.join('\n') + '\n', (err) => {
                        if (err) {
                            console.error('Error writing success logs:', err);
                        }
                    });
                }

                // Contar y registrar errores
                const errorCount = logError.length;
                if (errorCount > 0) {
                    fs.appendFile('logsErrorUpdateMetadataBYEMAILORDNI.txt', logError.join('\n') + '\n', (err) => {
                        if (err) {
                            console.error('Error writing error logs:', err);
                        }
                    });
                }

                // Agregar conteo al final de los logs
                fs.appendFile('logsSummaryUpdateMetadataByEMAILORDNI.txt', `Total metadata updates: ${count}\nTotal errors: ${errorCount}\n`, (err) => {
                    if (err) {
                        console.error('Error writing summary logs:', err);
                    }
                });

                res.json(users);

            } catch (error) {
                console.error('Error updating user metadata:', error);
                res.status(500).send('Error updating user metadata.');
            }
        });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).send('Error processing request.');
    }
});

// Ruta para borrar usuario en Auth0 por email leido de la tabla auth0_user
app.get('/users/delete-auth0-user', async (req, res) => {
    const limitParam = parseInt(req.query.limit, 10) || 100;
    const offset = parseInt(req.query.offset, 10) || 0;

    let count = 0;
    const logSuccess = [];
    const logError = [];

    try {
        const query = 'SELECT * FROM auth0_user LIMIT ? OFFSET ?';
        db.query(query, [limitParam, offset], async (err, results) => {
            if (err) {
                console.error('Error reading data from MySQL:', err);
                return res.status(500).send('Error reading data from MySQL.');
            }

            try {
                const token = await getAuth0Token();

                const usersPromises = results.map((row) => limit(async () => {
                    const email = row.Email;
                    const auth0User = await getAuth0UserByEmail(token, email);

                    if (auth0User) {
                        await deleteUserInAuth0(auth0User.user_id, token);
                        count++;
                        logSuccess.push(`User deleted in Auth0: ${auth0User.user_id} (${count})`);
                        console.log(`User deleted in Auth0: ${auth0User.user_id} (${count})`);
                    }

                    return { email, auth0User };
                }));

                const users = await Promise.all(usersPromises);

                // Escribir logs de éxito al final
                if (logSuccess.length) {
                    fs.appendFile('logsSuccessDeleteAuth0User.txt', logSuccess.join('\n') + '\n', (err) => {
                        if (err) {
                            console.error('Error writing success logs:', err);
                        }
                    });
                }

                // Contar y registrar errores
                const errorCount = logError.length;
                if (errorCount > 0) {
                    fs.appendFile('logsErrorDeleteAuth0User.txt', logError.join('\n') + '\n', (err) => {
                        if (err) {
                            console.error('Error writing error logs:', err);
                        }
                    });
                }

                // Agregar conteo al final de los logs
                fs.appendFile('logsSummaryDeleteAuth0User.txt', `Total users deleted: ${count}\nTotal errors: ${errorCount}\n`, (err) => {
                    if (err) {
                        console.error('Error writing summary logs:', err);
                    }
                });

                res.json(users);

            } catch (error) {
                console.error('Error deleting user in Auth0:', error);
                res.status(500).send('Error deleting user in Auth0.');
            }
        });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).send('Error processing request.');
    }
});

// Ruta para borrar usuarios en Auth0 leyendo desde un array de emails
app.get('/users/delete-auth0-user-by-email-array', async (req, res) => {
    const emails = [
        'la_mole99@hotmail.com',
        'martingomezc+1@hotmail.com',
        'henryvarg@gmail.com',
    ];
    
    let count = 0;
    const logSuccess = [];
    const logError = [];

    try {
        const token = await getAuth0Token();

        const usersPromises = emails.map((email) => limit(async () => {
            try {
                const auth0User = await getAuth0UserByEmail(token, email);

                if (auth0User) {
                    await deleteUserInAuth0(auth0User.user_id, token);
                    count++;
                    logSuccess.push(`User deleted in Auth0: ${auth0User.user_id} (${count})`);
                    console.log(`User deleted in Auth0: ${auth0User.user_id} (${count})`);
                }
            } catch (error) {
                logError.push(`Error deleting user with email ${email}: ${error.message}`);
                console.error(`Error deleting user with email ${email}:`, error);
            }
        }));

        await Promise.all(usersPromises);

        // Escribir logs de éxito
        if (logSuccess.length) {
            fs.appendFile('logsSuccessDeleteAuth0User.txt', logSuccess.join('\n') + '\n', (err) => {
                if (err) {
                    console.error('Error writing success logs:', err);
                }
            });
        }

        // Escribir logs de error
        if (logError.length) {
            fs.appendFile('logsErrorDeleteAuth0User.txt', logError.join('\n') + '\n', (err) => {
                if (err) {
                    console.error('Error writing error logs:', err);
                }
            });
        }

        // Agregar conteo al final de los logs
        fs.appendFile('logsSummaryDeleteAuth0User.txt', `Total users deleted: ${count}\nTotal errors: ${logError.length}\n`, (err) => {
            if (err) {
                console.error('Error writing summary logs:', err);
            }
        });

        res.json({ message: 'User deletion process completed', totalDeleted: count, totalErrors: logError.length });

    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).send('Error processing request.');
    }
});



// Ruta para leer datos de MySQL y buscar en Auth0 para actualizar metadata solo genero
app.get('/users/update-metadata-gender-auth0', async (req, res) => {
    const limitParam = parseInt(req.query.limit, 10) || 100;
    const offset = parseInt(req.query.offset, 10) || 0;
    let count = 0;

    try {
        const query = 'SELECT * FROM auth0_user LIMIT ? OFFSET ?';
        db.query(query, [limitParam, offset], async (err, results) => {
            if (err) {
                console.error('Error reading data from MySQL:', err);
                return res.status(500).send('Error reading data from MySQL.');
            }

            try {
                const token = await getAuth0Token();

                const usersPromises = results.map((row) => limit(async () => {
                    const email = row.Email;
                    const gender = getGender(row.gender);

                    const auth0User = await getAuth0UserByEmail(token, email);

                    if (auth0User) {
                        await updateAuth0UserMetadataGender(token, auth0User.user_id, gender);
                        count++;
                        console.log(`User metadata updated for Auth0 user in Gender: ${auth0User.user_id} (${count})`);
                    }

                    return { email, auth0User };
                }));

                const users = await Promise.all(usersPromises);
                res.json(users);

            } catch (error) {
                console.error('Error updating user metadata:', error);
                res.status(500).send('Error updating user metadata.');
            }
        });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).send('Error processing request.');
    }
});



// Ruta para leer datos de MySQL y actualizar la fecha de nacimiento en Auth0 si es necesario
app.get('/users/update-metadata-birthday-auth0', async (req, res) => {
    const limitParam = parseInt(req.query.limit, 10) || 100;
    const offset = parseInt(req.query.offset, 10) || 0;
    let count = 0;
    const logSuccess = [];
    const logError = [];

    try {
        const query = "SELECT * FROM users_auth0.auth0_user";
        db.query(query, [limitParam, offset], async (err, results) => {
            if (err) {
                console.error('Error reading data from MySQL:', err);
                return res.status(500).send('Error reading data from MySQL.');
            }

            try {
                const token = await getAuth0Token();

                const usersPromises = results.map((row) => limit(async () => {
                    const email = row.Email;
                    let birthday = row.birthday;
console.log('birthday:', birthday);
                    // Comprobar si la fecha es válida y puede ser convertida
                    if (birthday && shouldConvertBirthday(birthday)) {
                        // Convertir el cumpleaños al formato deseado: 'YYYY-MM-DDTHH:mm:ss'
                        const formattedBirthday = convertBirthday(birthday);

                        if (formattedBirthday) {
                            const auth0User = await getAuth0UserByEmail(token, email);

                            if (auth0User) {
                                await updateAuth0UserMetadataBirthday(token, auth0User.user_id, formattedBirthday);
                                count++;
                                logSuccess.push(`User metadata updated for Auth0 user in Birthday: ${auth0User.user_id} (${count})`);
                                console.log(`User metadata updated for Auth0 user in Birthday: ${auth0User.user_id} (${count})`);
                            }
                        } else {
                            logError.push(`Skipping user ${email}: unable to convert birthday.`);
                            console.log(`Skipping user ${email}: unable to convert birthday.`);
                        }
                    } else {
                        logError.push(`Skipping user ${email}: invalid or null birthday.`);
                        console.log(`Skipping user ${email}: invalid or null birthday.`);
                    }

                    return { email };
                }));

                const users = await Promise.all(usersPromises);
                
                // Escribir logs de éxito al final
                if (logSuccess.length) {
                    fs.appendFile('logsSuccessUpdateMetadataBirthday.txt', logSuccess.join('\n') + '\n', (err) => {
                        if (err) {
                            console.error('Error writing success logs:', err);
                        }
                    });
                }
                
                // Escribir logs de error al final
                if (logError.length) {
                    fs.appendFile('logsErrorUpdateMetadataBirthday.txt', logError.join('\n') + '\n', (err) => {
                        if (err) {
                            console.error('Error writing error logs:', err);
                        }
                    });
                }
                
                // Agregar conteo al final de los logs
                fs.appendFile('logsSummaryUpdateMetadataBirthday.txt', `Total metadata updates: ${count}\nTotal errors: ${logError.length}\n`, (err) => {
                    if (err) {
                        console.error('Error writing summary logs:', err);
                    }
                });
                
                res.json({ updatedUsers: users.length, totalProcessed: count });

            } catch (error) {
                console.error('Error updating user metadata:', error);
                res.status(500).send('Error updating user metadata.');
            }
        });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).send('Error processing request.');
    }
});



// Ruta para limpiar la tabla user de MySQL
app.post('/users/clear-table', (req, res) => {
    const query = 'TRUNCATE TABLE user';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error truncating table:', err);
            return res.status(500).send('Error truncating table.');
        }
        console.log('Tabla user limpiada.');
        res.send('Tabla user limpiada.');
    });
});
// Ruta para limpiar la tabla user filtered de MySQL
app.post('/users/clear-table-user-filtered', (req, res) => {
    const query = 'TRUNCATE TABLE user_filtered';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error truncating table:', err);
            return res.status(500).send('Error truncating table.');
        }
        console.log('Tabla user_filtered limpiada.');
        res.send('Tabla user_filtered limpiada.');
    });
});

// Ruta para limpiar la tabla auth0_user de MySQL
app.post('/users/clear-table-auth0', (req, res) => {
    const query = 'TRUNCATE TABLE auth0_user';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Error truncating table:', err);
            return res.status(500).send('Error truncating table.');
        }
        console.log('Tabla auth0_user limpiada.');
        res.send('Tabla auth0_user limpiada.');
    });
});

// Iniciar el servidor
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}/`);
});
